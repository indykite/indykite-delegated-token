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

import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit, urlunsplit

from indykite_delegated_token._constants import MCP_EXTENSION_ID

if TYPE_CHECKING:
    import anyio

__all__ = [
    "DEFAULT_REGISTRY",
    "ExtensionRegistry",
    "Fetch",
    "challenge_link",
    "metadata_url",
    "same_origin",
    "target_key",
]

logger = logging.getLogger(__name__)

WELL_KNOWN_PATH = "/.well-known/oauth-protected-resource"

# Fetches a URL with a plain GET and returns the status code and the body. Raises on a network error.
Fetch = Callable[[str], Awaitable[tuple[int, bytes]]]

_DEFAULT_PORTS = {"http": 80, "https": 443}
_RESOURCE_METADATA = re.compile(r'resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))', re.IGNORECASE)


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


def same_origin(a: str, b: str) -> bool:
    """Whether ``a`` and ``b`` have the same scheme, host and port. A URL that cannot be parsed has no origin."""
    try:
        return _origin(a) == _origin(b)
    except ValueError:  # e.g. a port that is not a number
        return False


def metadata_url(target: str) -> str:
    """The RFC 9728 metadata URL of ``target``: the well-known path inserted between its host and its path and query.

    Only the slash that directly follows the host is dropped (RFC 9728 section 3.1); any other path is kept as is.
    """
    key = urlsplit(target_key(target))
    path = "" if key.path == "/" else key.path
    return urlunsplit((key.scheme, key.netloc, WELL_KNOWN_PATH + path, key.query, ""))


def resource_metadata_link(www_authenticate: str) -> str | None:
    """The ``resource_metadata`` parameter of a ``WWW-Authenticate`` header, if any."""
    match = _RESOURCE_METADATA.search(www_authenticate)
    if match is None:
        return None
    return match.group(1) or match.group(2) or None


def challenge_link(target: str, www_authenticate: str) -> str | None:
    """The ``resource_metadata`` link of a 401's ``WWW-Authenticate``, if it can be followed for ``target``.

    It can only if it is on the target's origin, so a target cannot make the client fetch another host, or announce
    for one.
    """
    link = resource_metadata_link(www_authenticate)
    if link is None:
        return None
    if not same_origin(link, target):
        logger.warning("ignoring resource_metadata link %s of %s, not on its origin", link, target_key(target))
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


def _cacheable(status: int) -> bool:
    return 200 <= status < 300 or status == 404


class _Attempt:
    """A metadata fetch in progress, whose result its concurrent callers share."""

    def __init__(self) -> None:
        import anyio

        self.done: anyio.Event = anyio.Event()
        self.result = False


class ExtensionRegistry:
    """Remembers which targets announce the extension, for the life of the process.

    Answers of the metadata endpoint, 2xx and 404, are cached. Network errors and other statuses are not, so the next
    call to the target tries again. A target that is known to announce is never downgraded.
    """

    def __init__(self) -> None:
        self._announced: dict[str, bool] = {}
        # Fetches in progress, per event loop: an event can only be awaited in the loop it belongs to, and the
        # registry may be shared by clients running in different threads, each with its own loop
        self._attempts: dict[tuple[object, ...], _Attempt] = {}

    def known(self, target: str) -> bool | None:
        """``True`` or ``False`` when the target's answer is cached, ``None`` when it is not known yet."""
        return self._announced.get(target_key(target))

    def clear(self) -> None:
        """Forget every target."""
        self._announced.clear()

    async def _shared(self, what: tuple[str, ...], run: Callable[[], Awaitable[bool]]) -> bool:
        # Callers that arrive while a fetch is in progress wait for it and take its result, also a failure, rather
        # than fetching again one after the other. Callers that arrive after it start a new one.
        from anyio.lowlevel import current_token

        attempt_key = (current_token(), *what)
        attempt = self._attempts.get(attempt_key)
        if attempt is not None:
            await attempt.done.wait()
            return attempt.result
        attempt = self._attempts[attempt_key] = _Attempt()
        try:
            attempt.result = await run()
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
        cached = self._announced.get(key)
        if cached is not None:
            return cached
        return await self._shared(("metadata", key), lambda: self._fetch(key, metadata_url(key), fetch))

    async def learn_from_challenge(self, target: str, www_authenticate: str, fetch: Fetch) -> bool:
        """Follow the ``resource_metadata`` link of a 401 and return whether ``target`` announces now.

        The link is followed only if :func:`challenge_link` accepts it. Concurrent calls with the same link share one
        fetch.
        """
        key = target_key(target)
        link = challenge_link(key, www_authenticate)
        if link is None:
            return self._announced.get(key, False)
        if self._announced.get(key):
            return True
        return await self._shared(("challenge", key, link), lambda: self._fetch(key, link, fetch))

    async def _fetch(self, key: str, url: str, fetch: Fetch) -> bool:
        try:
            status, body = await fetch(url)
        except Exception as exc:  # network errors are not cached
            logger.warning("fetching protected resource metadata %s failed: %s", url, exc)
            return False
        announced = _announces(key, status, body)
        if _cacheable(status):
            # A slower fetch of the well-known URL must not undo what a challenge's link has shown
            self._announced[key] = announced or self._announced.get(key, False)
        else:
            logger.warning("protected resource metadata %s returned %d", url, status)
        return announced


# The registry the client transports use unless they are given one
DEFAULT_REGISTRY = ExtensionRegistry()
