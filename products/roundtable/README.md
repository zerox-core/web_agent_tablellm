# TableLLM v1

The roundtable is a standalone local workbench. Its default browser path uses a dedicated Chrome profile over CDP and Playwright; the compatibility extension is optional and tested separately.

Version `1.0.1` depends on the independently released `@web-agents/local-core@1.1.0` package. It contains no web_Agent plugin source or vendored core copy.

## Local workbench switch

The roundtable exists to discuss plans, not to do local work by default. MCP tool
read/write against the local filesystem is gated behind the per-session
`workbenchEnabled` switch (advanced settings drawer, default off). While off,
turns run through the plain browser worker and model text is treated as
discussion only — no tool protocol is injected and no tool call is executed.
When a session opts in, turns route through the controller tool worker, which
prevents conflicting writes: only the designated write executor may run mutating
tools (all other seats stay read-only and can only propose), low-confidence model
output is blocked from side effects, out-of-workspace writes require explicit
user confirmation, and every mutating call runs inside a rollbackable
transaction.

## Commands

- `npm run start:roundtable` starts the workbench server.
- `npm run test:roundtable` runs the extension-independent roundtable suites.
- `npm --workspace @web-agents/roundtable-product run test:compat` verifies the temporary compatibility extension.
- `start-roundtable.bat` starts the Windows launcher and dedicated browser lifecycle.

Workspace sessions live under `<workspace>/.web-agents`. Product browser state and logs live under `products/roundtable/data` unless a user-local override is supplied.

The default lifecycle owns only the workbench on `3020`, dedicated Chrome CDP on `9223`, and Playwright MCP on `8931`. Filesystem operations run in process through `@web-agents/local-core`; the roundtable does not start or depend on plugin ports `3006/3017`.
