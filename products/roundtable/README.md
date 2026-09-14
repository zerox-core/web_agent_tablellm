# TableLLM v1

The roundtable is a standalone local workbench. Its default browser path uses a dedicated Chrome profile over CDP and Playwright; the compatibility extension is optional and tested separately.

Version `1.0.1` depends on the independently released `@web-agents/local-core@1.1.0` package. It contains no web_Agent plugin source or vendored core copy.

## Commands

- `npm run start:roundtable` starts the workbench server.
- `npm run test:roundtable` runs the extension-independent roundtable suites.
- `npm --workspace @web-agents/roundtable-product run test:compat` verifies the temporary compatibility extension.
- `start-roundtable.bat` starts the Windows launcher and dedicated browser lifecycle.

Workspace sessions live under `<workspace>/.web-agents`. Product browser state and logs live under `products/roundtable/data` unless a user-local override is supplied.

The default lifecycle owns only the workbench on `3020`, dedicated Chrome CDP on `9223`, and Playwright MCP on `8931`. Filesystem operations run in process through `@web-agents/local-core`; the roundtable does not start or depend on plugin ports `3006/3017`.
