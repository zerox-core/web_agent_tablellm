import { BaseProviderAdapter } from "./base-adapter.mjs";

// Provisional selector set (2026-09-14): the GLM (Z.ai) seat was registered per
// user request. Same caveat as KimiAdapter: selectors need live DOM
// verification; see docs/provider-adapters/verification-matrix.md.
export class GlmAdapter extends BaseProviderAdapter {
  constructor({ url = "https://chat.z.ai/" } = {}) {
    super({
      id: "glm",
      label: "GLM",
      url,
      inputSelectors: [
        "textarea[placeholder*='发送']",
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
        ".prose",
        "[class*='markdown']:not([contenteditable='true']):not([class*='chat-user'])",
        "[class*='chat-assistant']",
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
