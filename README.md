# IndyKite delegated token

Packages for the delegated token propagation of the IndyKite Agent Gateway.

The gateway issues a delegated token for each workflow of AI agents and sends it to the agents in the `X-IK-Token` header.
These packages let an agent or an MCP server forward the delegated token on its own outbound calls,
so the token reaches every hop of the workflow.

> [!WARNING]
> Work in progress. The packages are not published yet.

## Packages

| Language | Folder | Package | Registry | Release tag |
| --- | --- | --- | --- | --- |
| Python | [`python/`](python/) | `indykite-delegated-token` | PyPI | `python/vX.Y.Z` |
| TypeScript, JavaScript | [`typescript/`](typescript/) | `@indykite/delegated-token` | npm | `typescript/vX.Y.Z` |

All packages implement the same extension: the same header, the same discovery and the same rules.
A change to the behavior is made in every language in the same pull request.

## Versioning

Each package follows [Semantic Versioning](https://semver.org/) and is released on its own,
with its own version, tag and changelog (`<folder>/CHANGELOG.md`).
Releases are prepared by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/); the commit scope is the language folder, e.g. `feat(python): ...`.

## Contributing

See [contributing.md](contributing.md). Security issues: see [responsible_disclosure.md](responsible_disclosure.md).

## License

[Apache-2.0](LICENSE)
