[简体中文](README.md) | **English**

# TableLLM

TableLLM is a local roundtable workbench that lets multiple web-based AI models discuss the same topic over multiple cycles. It coordinates seats, cycles, shared context, browser execution, and filesystem transactions while preserving each model's original response instead of reducing the discussion to a fixed-field summary.

This branch contains only the roundtable product. It does not contain the normal web_Agent plugin product or a copied Local Core source tree.

![Roundtable workbench](products/roundtable/docs/assets/roundtable-overview.png)

## Product Scope

TableLLM is intended for tasks that benefit from independent model judgment and direct responses between models, including design reviews, technical disputes, risk analysis, source comparison, and research discussions that require different perspectives.

The current stable automation seats are ChatGPT, DeepSeek, and Doubao. Gemini, Qwen, Kimi, GLM, Grok, and Google AI Studio appear in the provider catalog but remain marked as planned and must not be treated as stable automation support.

TableLLM does more than send one prompt to several providers and concatenate the answers. It maintains a recoverable discussion plan, one thread per seat, cycle snapshots, reply relations, capacity state, and a final closure.

## How the Roundtable Discusses

1. The user creates a roundtable, selects seats, and provides a task.
2. During the first cycle, each seat responds independently from the same initial context so later completions cannot follow answers from the same cycle.
3. When the cycle ends, completed raw responses enter the public ledger; seats in the next cycle receive the same updated snapshot.
4. Models can respond, challenge, revise, or add detail. Explicit names create message-level reply relations, but the system does not infer permanent camps.
5. A seat with nothing useful to add can return an internal `PASS`. It appears as listening for that cycle and may rejoin later.
6. At the cycle limit, natural convergence, or user cancellation, the east-host closes the discussion from the public raw transcript.

The east-host is not an extra moderator model. It is one of the existing seats. The user can assign it through the seat layout; if it becomes unavailable, the scheduler selects a temporary closer from available seats.

## Two Execution Modes

| Mode | Behavior | Best for |
| --- | --- | --- |
| Discussion | Seats in one cycle respond independently from the same snapshot, then advance together | Parallel perspectives, review, debate, and consensus formation |
| Relay | Context passes through seats in order and returns to the east-host for closure | Relay writing, staged refinement, and sequential reasoning |

Discussion is the default. The default maximum is five cycles and can be changed in the workbench.

## Workbench Capabilities

- Free seat positioning with snap-to-host assignment.
- Speaking, waiting, listening, error, login, and recovery states.
- Raw public responses with cycle metadata and message-level reply relations.
- Stable reading position while models stream, without forced scrolling.
- A down-arrow control after the complete run finishes when the reader is not at the bottom.
- User interventions queued for the next cycle, editable or removable before commit.
- Persistent seat roles and task-scoped role overrides.
- Context-capacity tracking and seat-thread handoff near configured thresholds.
- Compressed context alongside recent raw events; compression can be reviewed and revised and never replaces the public ledger.
- Pause, resume, cancellation, and recovery for uncertain submission, expired login, or browser failure.
- Permission checks, transaction records, and verifiable rollback for model-requested local filesystem changes.

## System Components

```text
TableLLM workbench :3020
  ↓ Session, seat, cycle, event stream, permission, and recovery UI
Roundtable scheduler
  ↓ Discussion/relay plans, context projection, compression, retry, closure
Browser runtime
  ├─ Dedicated Chrome CDP :9223
  ├─ Playwright MCP :8931
  └─ Optional compatibility extension channel
@web-agents/local-core
  ↓ Workspace paths, permissions, transactions, atomic writes, filesystem tools
<workspace>/.web-agents
```

The default lifecycle uses a dedicated Chrome profile, CDP, and Playwright. The compatibility extension is an optional, separately tested channel rather than a default startup dependency. The roundtable does not start or depend on plugin ports `3006/3017`.

## Requirements

- Windows 10 or Windows 11.
- Node.js 24 or newer.
- Chrome, with permission to start a project-owned profile.
- Signed-in accounts for the provider websites you plan to seat.
- Local ports `3020`, `9223`, and `8931` available.

## Install and Start

Install dependencies from the roundtable branch root:

```powershell
npm ci
```

Use the complete Windows launcher for normal operation:

```powershell
.\products\roundtable\start-roundtable.bat
```

The launcher checks the environment and ports, starts the dedicated Chrome, Playwright MCP, and roundtable service, then opens:

```text
http://127.0.0.1:3020
```

To start only the workbench service:

```powershell
npm run start:roundtable
```

Service-only startup does not prepare provider pages. Prefer the complete BAT launcher for real website automation.

## Browser and Model Connections

Default CDP mode uses a dedicated browser profile under `products/roundtable/data/browser-profile` and does not reuse the everyday Chrome profile. On first startup, sign in to ChatGPT, DeepSeek, Doubao, and any other planned seats inside that dedicated browser.

When a new roundtable is created, the runtime checks whether provider pages are authenticated and whether a usable composer exists, then establishes a verifiable page binding for each seat. Bindings accept only the correct provider origin and a tab that actually exists. Queries, fragments, and URL credentials are not exposed through status APIs.

A new seat thread prefers an existing idle provider tab and opens a fresh conversation. If the page redirects to login, verification, or another provider, the binding is invalidated and the workbench asks the user to reconnect.

Compatibility-extension mode trusts only the fixed local roundtable origin and requires port `3020`. Do not treat the normal web_Agent plugin as the default roundtable extension; the compatibility package is under `products/roundtable/compat-extension`.

## Workspaces, Files, and Permissions

Select an existing local workspace after startup. Each workspace independently stores:

```text
<workspace>/.web-agents/
  sessions/                             Sessions, public events, and plans
  config/allowed-directories.txt        Writable directories approved for this workspace
  transactions/                         Filesystem transactions and recovery records
  audit/                                Operation audit
  backups/                              Rollback backups
```

Mutations inside a workspace can follow product policy automatically; external mutations require explicit path basis or user approval. Permission state belongs to the workspace and is not shared with the web_Agent plugin allowlist.

When a model emits a mutating tool call, only one explicit write executor may own the current task. Transactions record pre-change state, hashes, backups, and execution IDs. A failure rolls back changed paths automatically, while a later user edit that conflicts with the transaction hash is never overwritten silently.

Single-file deletion is permission-gated and audited. Recursive directory deletion is not a public filesystem tool.

## Local Ports and Data

| Service | Default address or port | Purpose |
| --- | --- | --- |
| TableLLM | `http://127.0.0.1:3020` | Workbench, API, and event stream |
| Chrome CDP | `9223` | Dedicated Chrome debugging connection |
| Playwright MCP | `8931` | Browser automation service |

Product-level browser profiles, launcher receipts, and logs live under `products/roundtable/data` by default. Session business data lives under `.web-agents` in the selected workspace.

`products/roundtable/config/data-root.local.txt` can override the product data location on the current machine. Never commit `*.local.*`, browser profiles, logs, account state, or real session content.

## Testing

Run the complete verification pipeline:

```powershell
npm test
```

The complete command covers product boundaries, Core, browser end-to-end, launcher, and compatibility-extension tests. Individual commands are also available:

```powershell
npm run check:boundaries
npm run test:roundtable
npm run test:compat
npm --workspace @web-agents/roundtable-product run test:core
npm --workspace @web-agents/roundtable-product run test:browser
npm --workspace @web-agents/roundtable-product run test:launcher
```

After changing a provider adapter, also verify authentication, insertion, submission, streaming capture, completion detection, and page reconnection manually in the dedicated Chrome.

## Troubleshooting

**The BAT window closes immediately**

Run `.\products\roundtable\start-roundtable.bat` from PowerShell to keep the complete error visible. Check Node.js, the Chrome path, and ports `3020/9223/8931`.

**Port `3020` is already occupied**

Open `http://127.0.0.1:3020/api/health` first to determine whether the same roundtable service is already running. Do not terminate an unidentified listener.

**A seat requires login or cannot connect**

Open the provider website in the project-owned Chrome, complete login or verification, and reconnect from the workbench. Authentication from an everyday browser profile is not shared automatically.

**The latest streaming text is not visible**

This is the reading-position protection behavior: streaming never forces scroll. After the whole run finishes, use the down arrow at the bottom of the conversation area to reach the latest message.

**No filesystem approval dialog appears**

Confirm that a workspace is selected and the task is still active, then check whether the path is already inside the workspace. Allowed workspace mutations may not require an extra dialog; external mutations need explicit path basis or the permission flow.

**The compatibility extension cannot connect**

Confirm that the roundtable uses fixed port `3020`, load only `products/roundtable/compat-extension`, and inspect its status. Compatibility-extension mode does not support a custom roundtable port.

## Versions and Branches

- Formal branch: `tablellm`.
- Current version: `1.0.1`.
- Release tag: `tablellm-v1.0.1`.
- Shared foundation: `@web-agents/local-core@1.0.0`, pinned to `local-core-v1.0.0`.
- The plugin product lives on the `webagent` branch of the separate repository [zhuxice-ctrl/web_agents](https://github.com/zhuxice-ctrl/web_agents); the two products are never merged.

## License

[MIT](LICENSE)
