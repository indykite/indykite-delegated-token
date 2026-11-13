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

import pytest

from indykite_delegated_token import get_delegated_token, use_token
from indykite_delegated_token._context import token_from_headers


def test_no_token_outside_a_request() -> None:
    assert get_delegated_token() is None


def test_use_token_resets() -> None:
    with use_token("outer"):
        with use_token("inner"):
            assert get_delegated_token() == "inner"
        assert get_delegated_token() == "outer"
    assert get_delegated_token() is None


def test_use_token_resets_on_error() -> None:
    with pytest.raises(RuntimeError), use_token("token"):
        raise RuntimeError
    assert get_delegated_token() is None


def test_empty_token_is_none() -> None:
    with use_token(""):
        assert get_delegated_token() is None


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        ({"X-IK-Token": "a"}, "a"),
        ({"x-ik-token": "b"}, "b"),
        ({"X-Ik-Token": "c"}, "c"),
        ({"x-ik-token": ""}, None),
        ({}, None),
        (None, None),
    ],
)
def test_token_from_headers(headers: object, expected: str | None) -> None:
    assert token_from_headers(headers) == expected
