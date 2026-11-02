# IndyKite delegated token - Python

Python package for the delegated token propagation of the IndyKite Agent Gateway.

> [!WARNING]
> Work in progress, not published to PyPI yet.

## Installation

```sh
pip install indykite-delegated-token
```

Python 3.11+ is required.

## Development

```sh
uv sync                            # create .venv with the package and dev tools
uv run pytest                      # unit tests
uv run ruff check && uv run ruff format --check
uv run mypy
```

## License

[Apache-2.0](https://github.com/indykite/indykite-delegated-token/blob/master/LICENSE)
