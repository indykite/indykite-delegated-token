# IndyKite delegated token - TypeScript

TypeScript package for the delegated token propagation of the IndyKite Agent Gateway.
The package contains compiled JavaScript (ES modules) and type definitions, so plain JavaScript projects use it too.

> [!WARNING]
> Work in progress, not published to npm yet.

## Installation

```sh
npm install @indykite/delegated-token
```

Node.js 22+ is required.

## Development

```sh
corepack enable                    # use the pnpm version from package.json
pnpm install
pnpm test                          # unit tests
pnpm lint && pnpm format:check && pnpm typecheck
pnpm build                         # compile to dist/
```

## License

[Apache-2.0](https://github.com/indykite/indykite-delegated-token/blob/master/LICENSE)
