# Provider Adapter Contract

Applicable scope: browser automation seats in this repository, implemented under
`products/roundtable/app/automation/adapters/`. The authoritative contract is
`base-adapter.mjs`; this document is its human-readable mirror. When the two
disagree, the code wins and this document must be updated in the same change.

## Registered Seats

`adapters/index.mjs` exposes `createProviderAdapters({ urlOverrides })`, which
returns a `Map` of seat id to adapter instance. `urlOverrides.<id>` replaces the
default landing URL for that seat.

| Seat id | Class | Default URL |
| --- | --- | --- |
| `chatgpt` | `ChatGptAdapter` | `https://chatgpt.com/` |
| `deepseek` | `DeepSeekAdapter` | `https://chat.deepseek.com/` |
| `doubao` | `DoubaoAdapter` | `https://www.doubao.com/chat/` |

`BaseProviderAdapter` and the three concrete classes are re-exported from
`index.mjs` for tests and tooling.

## Configuration Fields

A seat adapter extends `BaseProviderAdapter` and, by convention, only passes
configuration to `super()` — behavior lives in the base class.

- `id`: stable lowercase seat id, matching the `PROVIDERS` entry in `app/core/providers.mjs`.
- `label`: human-readable seat name.
- `url`: default landing page for the seat.
- `inputSelectors[]`: ordered composer candidates. First visible and editable match wins.
- `submitSelectors[]`: ordered send-control candidates for `submit()`.
- `responseSelectors[]`: ordered reply-content candidates for `collectResponseCandidates()`.
- `busySelectors[]`: generation-in-progress markers (typically stop-button variants) for `isBusy()`.
- `loginSelectors[]`: login-prompt candidates used by `detectLoginRequired()`.
- `loginUrlPatterns[]`: login-page URL regexes (default: `/\/(?:auth\/)?(?:login|sign[_-]?in)(?:[/?#]|$)/i`).
- `humanVerificationSelectors[]`: captcha/verification candidates (default covers captcha, recaptcha, hcaptcha, turnstile, and verification iframes).
- `humanVerificationFramePattern`: regex matching verification iframe URLs (default: verifycenter/captcha/recaptcha/hcaptcha/turnstile).

## Behavior Contract

- `findComposer(page, { timeoutMs = 30000, signal })`: polls `inputSelectors`;
  each candidate must be visible and editable, then re-confirmed after 180ms
  (providers replace the composer while loading). Each poll round first calls
  `assertAutomationReady`; the login-selector fallback is disabled for the
  first 750ms so a still-loading page is not misread as logged out. On timeout
  throws `COMPOSER_NOT_FOUND`.
- `insertPrompt(page, composer, prompt)`: re-checks the composer (throws
  `COMPOSER_STALE` if it changed), scrolls into view, clicks, fills. Then
  reads the composer back (textarea/input use `.value`, otherwise
  innerText/textContent), normalizes whitespace, and requires the retained text
  to contain the first 60 characters of the normalized prompt; otherwise
  throws `PROMPT_INSERT_FAILED` with inserted/expected previews.
- `submit(page, composer, { timeoutMs = 10000, signal })`: loops
  `submitSelectors`, clicking the first visible and enabled control; if the
  deadline passes, falls back to pressing Enter on the composer; if that also
  fails, throws `SUBMIT_FAILED`.
- `collectResponseCandidates(page)`: walks `responseSelectors` (up to 60 matches
  each), normalizes text via `normalizeResponseText`, and deduplicates by
  stable identity: the closest ancestor carrying `data-message-id`,
  `data-testid^='conversation-turn-'`, or `data-observe-row`; otherwise a
  WeakMap-generated id. Prevents the same reply node from being counted twice
  across selectors.
- `isBusy(page)`: true when any busySelector matches a visible node.
- `detectLoginRequired(page)`: URL pattern first; if a usable composer exists,
  not logged out; only then loginSelectors. `isLoginRequired` is the boolean form.
- `detectHumanVerification(page)`: verification selectors, then any non-main
  frame whose URL matches `humanVerificationFramePattern`.
- `assertAutomationReady(page)`: two gates, in order — human verification, then
  login; each throws its error code with `providerId` and `phase` context.

## Error Codes

All errors are `AutomationError` instances from `app/automation/errors.mjs`,
carrying `providerId`, `phase`, and per-case context (selector, URL, previews):

- `HUMAN_VERIFICATION_REQUIRED`
- `LOGIN_REQUIRED`
- `COMPOSER_NOT_FOUND`
- `COMPOSER_STALE`
- `PROMPT_INSERT_FAILED`
- `SUBMIT_FAILED`

## Adding a New Seat

1. Create `adapters/<id>.mjs` extending `BaseProviderAdapter`; pass only the
   configuration fields above (selectors, url, labels).
2. Register the class in `adapters/index.mjs`: add to the `Map` built by
   `createProviderAdapters` and to the re-exports.
3. Add the seat to `PROVIDERS` in `app/core/providers.mjs` with
   `automation: "planned"`.
4. Pass the minimal acceptance checklist in `verification-matrix.md` (login,
   input, submit, streaming capture, completion detection, page reconnect)
   with a real browser session.
5. Only then flip `automation` to `"mvp"` and record the evidence in the matrix.

## History

The extension-era contract (content-script injection, MCP button injection,
file attachment, SSE sidebar) belonged to the former SuperAssistant extension
in the retired web_agents workspace and is not part of this repository. The
`compat-extension` in this repo is a workbench page bridge only
(background/content/protocol) and contains no seat adapters. Extension-era
verification evidence is archived in `verification-matrix.md`.
