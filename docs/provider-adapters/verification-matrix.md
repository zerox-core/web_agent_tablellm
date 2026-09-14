# Provider Adapter Verification Matrix

Two eras of seat automation exist in this project's history. The current era is
the CDP workbench: seats are driven through the dedicated Chrome CDP channel
by the adapters under `products/roundtable/app/automation/adapters/`. The
extension-era evidence at the bottom is archived for traceability and no longer
applies to the current code.

## Minimal Acceptance Checks (CDP Era)

Each seat must be verified against all six, with a real browser session:

1. Login: losing the session produces `LOGIN_REQUIRED` instead of a silent failure.
2. Input: `findComposer` + `insertPrompt` round-trip retains the prompt.
3. Submit: `submit` clicks a send control or falls back to Enter.
4. Streaming capture: `collectResponseCandidates` returns reply text with stable identities (no cross-seat or cross-turn mixing).
5. Completion detection: `isBusy` flips from true to false when generation ends.
6. Page reconnect: after a CDP disconnect the worker recovers (page lease rebuilt).

## Current Matrix (CDP Era)

Status reflects the project brief as of 2026-09-14. "Stable seat" here means:
adapter registered, wired into the workbench, and running in the user's real
sessions; live-site re-verification was not re-run as part of the 2026-09-14
documentation pass. Automated suites run against fake-provider e2e, not live
provider DOM.

| Provider | Adapter | Status | Evidence |
| --- | --- | --- | --- |
| ChatGPT | `ChatGptAdapter` | stable seat | Project brief 2026-09-14: stable automated seat; adapter registered in `adapters/index.mjs`; selectors cover `#prompt-textarea`, `data-testid` send/stop, `data-message-author-role='assistant'`. |
| DeepSeek | `DeepSeekAdapter` | stable seat | Project brief 2026-09-14: stable automated seat; adapter registered; selectors cover `.ds-markdown` responses and 发送/Stop controls. |
| 豆包 (Doubao) | `DoubaoAdapter` | stable seat | Project brief 2026-09-14: stable automated seat; adapter registered; first submit selector `button[class*='g-send-msg-btn']` originated from the 2026-06-30 extension-era observation (see archive below). |
| Gemini | — | not-started | `providers.mjs` lists `automation: "planned"`; 2026-09-14 user decision: do not add Gemini in the current seat expansion. |
| Qwen | — | not-started | `providers.mjs` lists `automation: "planned"`; no adapter file registered. |
| Kimi | `KimiAdapter` | registered, unverified | 2026-09-14: registered per user request with URL `https://www.kimi.com/agent?chat_enter_method=change_model`; selectors are provisional (shared composer/markdown conventions) and the six acceptance checks have not been run against the live site yet. |
| GLM | `GlmAdapter` | registered, unverified | 2026-09-14: registered per user request with URL `https://chat.z.ai/`; selectors are provisional and the six acceptance checks have not been run against the live site yet. |
| Grok | — | not-started | `providers.mjs` lists `automation: "planned"`; no adapter file registered. |
| Google AI Studio | — | not-started | `providers.mjs` lists `automation: "planned"`; no adapter file registered. |

## Status Values (CDP Era)

- `stable seat`: adapter registered and running in real workbench sessions per project brief.
- `pass`: all six acceptance checks verified with evidence this branch.
- `degraded`: checks 1-3 pass; optional behavior missing.
- `blocked`: cannot be verified (login, region, DOM, or provider behavior).
- `registered, unverified`: adapter registered and wired into the workbench, but none of the six acceptance checks have run against the live site yet (selectors are provisional).
- `not-started`: not verified in this branch; no adapter registered.

## Evidence Format

One short note per verification run, appended to the provider's Evidence cell:

```text
YYYY-MM-DD: pass. Browser: <Chrome x / Edge x>. Page: <url>. Checks: 1-6. Notes: <what deviated>.
```

## Archived: Extension-Era Evidence (2026-06-30)

Recorded against the former SuperAssistant extension (content script + MCP
sidebar + button injection) in the retired web_agents workspace. That
integration is not part of this repository; notes are kept because one
observation (the Doubao send button) was carried forward into the CDP adapter.

| Provider | Domain Pattern | Adapter | Status | Evidence |
| --- | --- | --- | --- | --- |
| ChatGPT | `chatgpt.com` | `ChatGPTAdapter` | not-started | Baseline regression check required. |
| Gemini | `gemini.google.com` | `GeminiAdapter` | not-started | Baseline regression check required. |
| DeepSeek | `chat.deepseek.com` | `DeepSeekAdapter` | not-started | Baseline regression check required. |
| Kimi | `kimi.com` | `KimiAdapter` | not-started | Baseline regression check required. |
| GLM/Z | `chat.z.ai`, `z.ai` | `ZAdapter` | not-started | Baseline regression check required. |
| Doubao | `doubao.com` | `DoubaoAdapter` | degraded | 2026-06-30: degraded. Browser: Chrome 149. Page: https://www.doubao.com/. Checks: 1-5 partial. Notes: content script injection, `DoubaoAdapter` activation, composer detection, text insertion, and MCP popover visibility verified; submit/result reinsertion not verified because committed submit selectors matched 0 buttons; observed candidate selector `button[class*="g-send-msg-btn"]` for future patch. |
| Grok | `grok.com`, `x.com`, `twitter.com` | `GrokAdapter` | blocked | 2026-06-30: blocked. Browser: Edge 149 with unpacked extension. Page: https://grok.com/. Checks: 1-2 partial. Notes: extension service worker loaded and Grok-specific MCP style/sidebar host appeared, but the Grok UI did not reach a composer before the Edge process exited; popover, text insertion, and submit were not verified. |
| Google AI Studio | `aistudio.google.com` | `AIStudioAdapter` | blocked | 2026-06-30: blocked. Browser: Edge 149. Page: https://aistudio.google.com/welcome. Checks: 1-2 partial; composer, SSE, popover-near-composer, text insertion, and submit were not verified. Notes: unauthenticated welcome/get-started page blocked composer access. |
| Qwen | `chat.qwen.ai`, `qwen.ai` | `QwenAdapter` | blocked | 2026-06-30: blocked. Browser: Edge 149 with unpacked extension. Page: https://chat.qwen.ai/. Checks: none. Notes: navigation failed with ERR_CONNECTION_CLOSED and landed on chrome-error://chromewebdata/; content script, adapter activation, popover, text insertion, submit, and CodeMirror/Monaco extraction were not verified. |
