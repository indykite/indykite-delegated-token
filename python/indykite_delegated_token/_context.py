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

"""The delegated token of the request being handled."""

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from indykite_delegated_token._constants import DELEGATED_TOKEN_HEADER

_delegated_token: ContextVar[str | None] = ContextVar("indykite_delegated_token", default=None)


def get_delegated_token() -> str | None:
    """Return the delegated token of the request being handled, or ``None`` outside a request."""
    return _delegated_token.get()


@contextmanager
def use_token(token: str | None) -> Iterator[None]:
    """Make ``token`` the delegated token for the duration of the block.

    The previous value is restored when the block exits, also on errors, so a token never outlives its request.
    """
    reset = _delegated_token.set(token or None)
    try:
        yield
    finally:
        _delegated_token.reset(reset)


def _text(value: object) -> object:
    return value.decode("latin-1") if isinstance(value, bytes) else value


def token_in(pairs: Iterable[tuple[object, object]]) -> str | None:
    """The delegated token in header ``(name, value)`` pairs, case-insensitively, as ``str`` or latin-1 ``bytes``.

    Returns ``None`` when the header is missing or empty.
    """
    wanted = DELEGATED_TOKEN_HEADER.lower()
    for name, value in pairs:
        name = _text(name)
        if isinstance(name, str) and name.lower() == wanted:
            value = _text(value)
            return value if isinstance(value, str) and value else None
    return None


def token_from_headers(headers: object) -> str | None:
    """Read the delegated token from a headers mapping, such as Starlette ``Headers``, see :func:`token_in`."""
    items = getattr(headers, "items", None)
    return token_in(items()) if items is not None else None
