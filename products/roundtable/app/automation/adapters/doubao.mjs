import { BaseProviderAdapter } from "./base-adapter.mjs";

export class DoubaoAdapter extends BaseProviderAdapter {
  constructor({ url = "https://www.doubao.com/chat/" } = {}) {
    super({
      id: "doubao",
      label: "豆包",
      url,
      inputSelectors: [
        'textarea[data-testid*="chat"]',
        'textarea[placeholder*="发消息"]',
        'textarea[placeholder*="发送"]',
        '[data-placeholder*="发消息"][contenteditable="true"]',
        '[aria-label*="发消息"][contenteditable="true"]',
        "div[contenteditable='true'][role='textbox']",
        ".semi-input-textarea[contenteditable='true']",
        "textarea:not([readonly]):not([disabled])",
        "div[contenteditable='true']",
      ],
      submitSelectors: [
        "button[class*='g-send-msg-btn']",
        "button[aria-label*='Send']",
        "button[aria-label*='发送']",
        "button[class*='send']",
        "button:has-text('发送')",
      ],
      // Loose fallback selectors are scoped to <main>: doubao renders the
      // auto-generated chat title in the left conversation list (outside main,
      // observed 2026-09-15) and an unscoped [class*='markdown'] match captured
      // the 25-byte title instead of the real answer.
      responseSelectors: [
        "[data-copy-telemetry='right_click_copy'] [data-message-id]",
        "main [data-testid='message-assistant']",
        "main [data-testid*='message'][data-testid*='assistant']",
        "main .flow-markdown-body",
        "main [class*='markdown']:not([contenteditable='true'])",
        "main [class*='answer-content']",
      ],
      busySelectors: [
        "[data-testid='stop-button']",
        "button[aria-label*='Stop']",
        "button[aria-label*='停止']",
        "button[class*='stop']",
      ],
      loginSelectors: [
        "button:has-text('登录')",
        "button:has-text('立即登录')",
        "a[href*='login']",
      ],
    });
  }
}
