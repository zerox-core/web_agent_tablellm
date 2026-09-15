import { BaseProviderAdapter } from "./base-adapter.mjs";

// Provisional selector set (2026-09-14): the Kimi seat was registered per user
// request. Selectors follow the shared composer/markdown conventions and still
// need live DOM verification; see docs/provider-adapters/verification-matrix.md.
export class KimiAdapter extends BaseProviderAdapter {
  constructor({ url = "https://www.kimi.com/agent?chat_enter_method=change_model" } = {}) {
    super({
      id: "kimi",
      label: "Kimi",
      url,
      inputSelectors: [
        "textarea[placeholder*='Kimi']",
        "textarea[placeholder*='发消息']",
        "textarea:not([readonly]):not([disabled])",
        "div[contenteditable='true'][role='textbox']",
        "div[contenteditable='true']",
      ],
      submitSelectors: [
        "button[aria-label*='发送']",
        "button[aria-label*='Send']",
        "button:has-text('发送')",
        "button[class*='send']",
      ],
      responseSelectors: [
        "[data-role='assistant']",
        ".segment-assistant [class*='markdown']:not([contenteditable='true'])",
        ".chat-content-item-assistant [class*='markdown']:not([contenteditable='true'])",
      ],
      busySelectors: [
        "button[aria-label*='停止']",
        "button[aria-label*='Stop']",
        "button[class*='stop']",
      ],
      loginSelectors: [
        "button:has-text('登录')",
        "button:has-text('Log in')",
        "a[href*='login']",
      ],
      loginUrlPatterns: [
        /\/(?:login|sign[_-]?in)(?:[/?#]|$)/i,
      ],
    });
  }
}
