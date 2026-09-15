import { BaseProviderAdapter } from "./base-adapter.mjs";

// Gemini (gemini.google.com) adapter. Provisional selector set: selectors
// need live DOM verification after the user logs into a Google account;
// see docs/provider-adapters/verification-matrix.md.
export class GeminiAdapter extends BaseProviderAdapter {
  constructor({ url = "https://gemini.google.com/app" } = {}) {
    super({
      id: "gemini",
      label: "Gemini",
      url,
      inputSelectors: [
        "rich-textarea .ql-editor[contenteditable='true']",
        ".ql-editor[contenteditable='true']",
        "div[contenteditable='true'][role='textbox']",
        "textarea:not([readonly]):not([disabled])",
        "div[contenteditable='true']",
      ],
      submitSelectors: [
        "button[aria-label*='Send']",
        "button.send-button",
        "button[class*='send']",
      ],
      responseSelectors: [
        ".model-response-text",
        "message-content",
        ".response-container .markdown",
        "main [class*='markdown']:not([contenteditable='true'])",
      ],
      busySelectors: [
        "button[aria-label*='Stop']",
        "button[class*='stop']",
      ],
      loginSelectors: [
        "a[href*='accounts.google.com']",
        "button:has-text('Sign in')",
        "button:has-text('Log in')",
      ],
      loginUrlPatterns: [/accounts\.google\.com/i],
    });
  }
}
