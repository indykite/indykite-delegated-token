# Copyright (c) 2026 IndyKite
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Discovery of the targets that announce the delegated token extension.

A target is an MCP endpoint. It announces the extension in its OAuth protected resource metadata (RFC 9728):
``mcp_extensions`` contains :data:`MCP_EXTENSION_ID` and ``resource`` is the target itself.
"""

from __future__ import annotations

import functools
import ipaddress
import json
import logging
import re
import threading
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from time import monotonic
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit, urlunsplit

from indykite_delegated_token._constants import MCP_EXTENSION_ID

if TYPE_CHECKING:
    import anyio

__all__ = [
    "DEFAULT_REGISTRY",
    "ExtensionRegistry",
    "Fetch",
    "UnusableMetadata",
    "challenge_link",
    "metadata_url",
    "same_origin",
    "secure_transport",
    "target_key",
    "within_origin",
]

logger = logging.getLogger(__name__)

WELL_KNOWN_PATH = "/.well-known/oauth-protected-resource"

# Fetches a URL with a plain GET and returns the status code and the body. Raises UnusableMetadata on an answer that
# cannot be used, and any other exception on a network error.
Fetch = Callable[[str], Awaitable[tuple[int, bytes]]]

_DEFAULT_PORTS = {"http": 80, "https": 443}
# A quoted string, skipped wherever it is so that it cannot hide a parameter, or the resource_metadata parameter, whose
# name must start the header or follow a space or a comma
_QUOTED = r'"(?:[^"\\]|\\.)*"'
_RESOURCE_METADATA = re.compile(
    rf'{_QUOTED}|(?<![^\s,])resource_metadata\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))', re.IGNORECASE
)


class UnusableMetadata(Exception):  # noqa: N818 - an answer, not an error of the client
    """The metadata endpoint answered, but with a body that cannot be used: too large, compressed, or too slow."""


def _origin(url: str) -> tuple[str, str, int | None]:
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    port = parts.port if parts.port is not None else _DEFAULT_PORTS.get(scheme)
    return scheme, (parts.hostname or "").lower(), port


def target_key(url: str) -> str:
    """Scheme, host, port, path and query of ``url``, without fragment and credentials.

    The query is kept: RFC 9728 identifies a protected resource by its whole URL, and two queries may select different
    resources behind the same path.
    """
    scheme, host, port = _origin(url)
    netloc = f"[{host}]" if ":" in host else host  # IPv6 literals keep their brackets
    if port is not None and _DEFAULT_PORTS.get(scheme) != port:
        netloc = f"{netloc}:{port}"
    parts = urlsplit(url)
    return urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))


def _redacted(url: str) -> str:
    """``url`` for the logs: scheme, host, port and path, without the query, which may hold credentials."""
    try:
        parts = urlsplit(target_key(url))
    except ValueError:
        return "<invalid URL>"
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def same_origin(a: str, b: str) -> bool:
    """Whether ``a`` and ``b`` have the same scheme, host and port. A URL that cannot be parsed has no origin."""
    try:
        return _origin(a) == _origin(b)
    except ValueError:  # e.g. a port that is not a number
        return False


def within_origin(first: str, url: str) -> bool:
    """Whether ``url`` is on the origin of ``first``, or is its upgrade from ``http`` to ``https`` on the same host.

    The upgrade must be between the default ports. It is the one the MCP SDK and httpx accept when they follow a
    redirect.
    """
    if same_origin(first, url):
        return True
    try:
        (scheme, host, port), (to_scheme, to_host, to_port) = _origin(first), _origin(url)
    except ValueError:
        return False
    return (scheme, port, to_scheme, to_port) == ("http", 80, "https", 443) and host == to_host


def secure_transport(url: str) -> bool:
    """Whether ``url`` is ``https``, or ``http`` to a loopback host.

    Over plain HTTP to another host, anyone on the network could read the token, or forge the metadata that announces
    the extension.
    """
    try:
        scheme, host, _ = _origin(url)
        return scheme == "https" or (
            scheme == "http" and (host == "localhost" or ipaddress.ip_address(host).is_loopback)
        )
    except ValueError:  # an unparsable URL, or a host name that is not an IP address
        return False


def metadata_url(target: str) -> str:
    """The RFC 9728 metadata URL of ``target``: the well-known path inserted between its host and its path and query.

    Only the slash that directly follows the host is dropped (RFC 9728 section 3.1); any other path is kept as is.
    """
    key = urlsplit(target_key(target))
    path = "" if key.path == "/" else key.path
    return urlunsplit((key.scheme, key.netloc, WELL_KNOWN_PATH + path, key.query, ""))


def resource_metadata_link(www_authenticate: str) -> str | None:
    """The ``resource_metadata`` parameter of a ``WWW-Authenticate`` header, if any.

    Text inside the quoted values of other parameters, such as ``error_description``, is not a parameter.
    """
    for match in _RESOURCE_METADATA.finditer(www_authenticate):
        quoted, token = match.group(1, 2)
        if quoted is None and token is None:  # a quoted string of another parameter
            continue
        return (re.sub(r"\\(.)", r"\1", quoted) if quoted is not None else token) or None
    return None


@functools.lru_cache(maxsize=1024)
def _warn_ignored_link(link: str, target: str) -> None:
    # Once per link and target, while they are among the most recent: a target that keeps answering 401 with such a
    # link would otherwise log on every call
    logger.warning("ignoring resource_metadata link %s of %s, not on its origin", _redacted(link), _redacted(target))


def challenge_link(target: str, www_authenticate: str) -> str | None:
    """The ``resource_metadata`` link of a 401's ``WWW-Authenticate``, if it can be followed for ``target``.

    It can only if it is on the target's origin, so a target cannot make the client fetch another host, or announce
    for one.
    """
    link = resource_metadata_link(www_authenticate)
    if link is None:
        return None
    if not same_origin(link, target):
        _warn_ignored_link(link, target_key(target))
        return None
    return link


def _announces(target: str, status: int, body: bytes) -> bool:
    if not 200 <= status < 300:
        return False
    try:
        metadata: Any = json.loads(body)
    except ValueError:
        return False
    if not isinstance(metadata, dict):
        return False
    extensions = metadata.get("mcp_extensions")
    resource = metadata.get("resource")
    if not isinstance(extensions, dict) or MCP_EXTENSION_ID not in extensions or not isinstance(resource, str):
        return False
    # RFC 9728 section 3.3: the metadata only counts for the resource it names
    try:
        return target_key(resource) == target_key(target)
    except ValueError:  # a resource URL that cannot be parsed names no target
        return False


class _Attempt:
    """A metadata fetch in progress, whose result its concurrent callers share."""

    def __init__(self) -> None:
        import anyio

        self.done: anyio.Event = anyio.Event()
        self.result = False
        self.aborted = False  # cancelled before it finished: its result says nothing about the target


class ExtensionRegistry:
    """Remembers which targets announce the extension, and to which the token may go.

    Answers of the metadata endpoint, 2xx and 404, are cached for ``ttl`` seconds; other statuses, such as 401 or 5xx,
    and answers that cannot be used, see :class:`UnusableMetadata`, count as not announced for ``error_ttl`` seconds;
    network errors are not cached. While its entry lasts, a target known to announce is not downgraded. The
    ``max_targets`` most recently used targets are kept. The token only goes to targets that pass
    :func:`secure_transport`, unless ``allow_http``, for example inside a private network.
    """

    def __init__(
        self, *, ttl: float = 3600.0, error_ttl: float = 60.0, max_targets: int = 1024, allow_http: bool = False
    ) -> None:
        self.allow_http = allow_http
        self._ttl = ttl
        self._error_ttl = error_ttl
        self._max_targets = max_targets
        # Target key, or (target key, challenge link) -> (announced, expiry on the monotonic clock), least recently
        # used first
        self._announced: OrderedDict[str | tuple[str, str], tuple[bool, float]] = OrderedDict()
        self._lock = threading.Lock()  # the registry may be shared by clients running in different threads
        # Fetches in progress, per event loop: an event can only be awaited in the loop it belongs to, and the
        # registry may be shared by clients running in different threads, each with its own loop
        self._attempts: dict[tuple[object, ...], _Attempt] = {}

    def known(self, target: str) -> bool | None:
        """``True`` or ``False`` when the target's answer is cached, ``None`` when it is not known yet."""
        return self._get(target_key(target))

    def clear(self) -> None:
        """Forget every target."""
        with self._lock:
            self._announced.clear()

    def _get(self, key: str | tuple[str, str]) -> bool | None:
        with self._lock:
            entry = self._announced.get(key)
            if entry is None:
                return None
            if monotonic() >= entry[1]:
                del self._announced[key]
                return None
            self._announced.move_to_end(key)
            return entry[0]

    def _set(self, key: str | tuple[str, str], announced: bool, ttl: float) -> None:
        with self._lock:
            entry = self._announced.get(key)
            # A slower fetch of the well-known URL must not undo what a challenge's link has shown; checked under the
            # same lock as the write, so another thread's positive answer cannot land in between
            if not announced and entry is not None and entry[0] and monotonic() < entry[1]:
                return
            self._announced[key] = (announced, monotonic() + ttl)
            self._announced.move_to_end(key)
            while len(self._announced) > self._max_targets:
                self._announced.popitem(last=False)

    async def _shared(
        self, what: tuple[str, ...], cached: Callable[[], bool | None], run: Callable[[], Awaitable[bool]]
    ) -> bool:
        # Callers that arrive while a fetch is in progress wait for it and take its result, also a failure, rather
        # than fetching again one after the other. Callers that arrive after it start a new one, and so do those whose
        # fetch was cancelled, for example with the call that led it: the first of them leads the next one.
        from anyio.lowlevel import current_token

        attempt_key = (current_token(), *what)
        while (attempt := self._attempts.get(attempt_key)) is not None:
            await attempt.done.wait()
            if not attempt.aborted:
                return attempt.result
            if (known := cached()) is not None:  # the next leader's fetch may have finished already
                return known
        attempt = self._attempts[attempt_key] = _Attempt()
        try:
            attempt.result = await run()
        except BaseException:
            attempt.aborted = True
            raise
        finally:
            del self._attempts[attempt_key]
            attempt.done.set()
        return attempt.result

    async def discover(self, target: str, fetch: Fetch) -> bool:
        """Whether ``target`` announces the extension, fetching its metadata once.

        Concurrent first calls for the same target share one fetch. A failed fetch counts as not announced for the
        calls that shared it only.
        """
        key = target_key(target)
        cached = self._get(key)
        if cached is not None:
            return cached
        return await self._shared(
            ("metadata", key), lambda: self._get(key), lambda: self._fetch(metadata_url(key), fetch, key)
        )

    async def learn_from_challenge(self, target: str, www_authenticate: str, fetch: Fetch) -> bool:
        """Follow the ``resource_metadata`` link of a 401 and return whether ``target`` announces now.

        The link is followed only if :func:`challenge_link` accepts it. Concurrent calls with the same link share one
        fetch, and its answer is cached like that of the well-known URL, so a target that keeps answering 401 does not
        make every request follow the link again.
        """
        key = target_key(target)
        link = challenge_link(key, www_authenticate)
        if link is None:
            return bool(self._get(key))
        cached = self._known_after_challenge(key, link)
        if cached is not None:
            return cached
        return await self._shared(
            ("challenge", key, link),
            lambda: self._known_after_challenge(key, link),
            lambda: self._fetch(link, fetch, key, (key, link)),
        )

    def _known_after_challenge(self, key: str, link: str) -> bool | None:
        if self._get(key):
            return True
        if self._get((key, link)) is False:  # the link was followed recently and did not announce
            return False
        return None

    async def _fetch(self, url: str, fetch: Fetch, key: str, *also: tuple[str, str]) -> bool:
        """Fetch the metadata at ``url``, and cache under ``key`` and ``also`` whether it announces for ``key``."""
        try:
            status, body = await fetch(url)
        except UnusableMetadata as exc:  # an answer, cached like an error status
            logger.warning("protected resource metadata %s is unusable: %s", _redacted(url), exc)
            announced, ttl = False, self._error_ttl
        except Exception as exc:  # network errors are not cached
            logger.warning("fetching protected resource metadata %s failed: %s", _redacted(url), exc)
            return False
        else:
            announced = _announces(key, status, body)
            if 200 <= status < 300 or status == 404:
                ttl = self._ttl
            else:
                logger.warning("protected resource metadata %s returned %d", _redacted(url), status)
                ttl = self._error_ttl
        keys: tuple[str | tuple[str, str], ...] = (key, *also)
        for k in keys:
            self._set(k, announced, ttl)
        return announced


# The registry the client transports use unless they are given one
DEFAULT_REGISTRY = ExtensionRegistry()
