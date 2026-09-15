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
        "[class*='chat-assistant'] .shimmer",
        "[class*='markdown'] .shimmer",
        "[data-role='assistant'] .shimmer",
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
  // GLM streams its deep-thinking process inside the assistant bubble under a
  // "正在思考/正在深度思考…" header while no stop button or shimmer element is
  // present (observed 2026-09-15). The header flips to 思考过程/已深度思考 once the
  // final answer starts, so a bubble that still starts with the transient
  // thinking header must be treated as busy to avoid capturing thinking text.
  async isBusy(page) {
    if (await super.isBusy(page)) return true;
    try {
      return await page.evaluate(() => {
        const bubbles = document.querySelectorAll("[class*='chat-assistant']");
        const last = bubbles[bubbles.length - 1];
        if (!last) return false;
        const text = String(last.innerText || "").trim();
        if (!text) return false;
        return /^(正在思考|正在深度思考|思考中)/.test(text);
      });
    } catch {
      return false;
    }
  }
}
