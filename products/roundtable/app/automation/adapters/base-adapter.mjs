import { AutomationError, abortableDelay, throwIfAborted } from "../errors.mjs";
import { normalizeResponseText } from "../completion-detector.mjs";

export class BaseProviderAdapter {
  constructor(config) {
    this.id = config.id;
    this.label = config.label;
    this.url = config.url;
    this.inputSelectors = config.inputSelectors || [];
    this.submitSelectors = config.submitSelectors || [];
    this.responseSelectors = config.responseSelectors || [];
    this.busySelectors = config.busySelectors || [];
    this.loginSelectors = config.loginSelectors || [];
    this.loginUrlPatterns = config.loginUrlPatterns || [
      /\/(?:auth\/)?(?:login|sign[_-]?in)(?:[/?#]|$)/i,
    ];
    this.humanVerificationSelectors = config.humanVerificationSelectors || [
      "#captcha_container",
      "iframe[src*='verifycenter']",
      "iframe[src*='captcha']",
      "iframe[src*='recaptcha']",
      "iframe[src*='hcaptcha']",
      "iframe[src*='turnstile']",
      "iframe[title*='captcha' i]",
      "iframe[title*='验证']",
      "[id*='captcha' i]",
      "[class*='captcha' i]",
    ];
    this.humanVerificationFramePattern = config.humanVerificationFramePattern
      || /(?:verifycenter|captcha|recaptcha|hcaptcha|challenges\.cloudflare\.com\/turnstile)/i;
    this.minSettleMs = config.minSettleMs || 0;
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      url: this.url,
      inputSelectors: this.inputSelectors,
      submitSelectors: this.submitSelectors,
      responseSelectors: this.responseSelectors,
      busySelectors: this.busySelectors,
      loginSelectors: this.loginSelectors,
      loginUrlPatterns: this.loginUrlPatterns.map((pattern) => pattern.source),
      humanVerificationSelectors: this.humanVerificationSelectors,
    };
  }

  urlMatchesLogin(page) {
    const currentUrl = page.url();
    return this.loginUrlPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(currentUrl);
    });
  }

  async hasUsableComposer(page) {
    for (const selector of this.inputSelectors) {
      const locator = page.locator(selector);
      let count = 0;
      try {
        count = Math.min(await locator.count(), 20);
      } catch {
        continue;
      }
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        try {
          if (await candidate.isVisible() && await candidate.isEditable()) return true;
        } catch {
          // Provider pages frequently replace the composer while loading.
        }
      }
    }
    return false;
  }

  async detectHumanVerification(page) {
    for (const selector of this.humanVerificationSelectors) {
      const locator = page.locator(selector).first();
      try {
        if ((await locator.count()) > 0 && await locator.isVisible()) {
          return { selector, url: page.url() };
        }
      } catch {
        // Try the next selector or frame URL.
      }
    }
    for (const frame of page.frames()) {
      const frameUrl = frame.url();
      this.humanVerificationFramePattern.lastIndex = 0;
      if (frame !== page.mainFrame() && this.humanVerificationFramePattern.test(frameUrl)) {
        return { frameUrl, url: page.url() };
      }
    }
    return null;
  }

  async detectLoginRequired(page, { allowSelectorFallback = true } = {}) {
    if (this.urlMatchesLogin(page)) return { reason: "url", url: page.url() };
    if (!allowSelectorFallback || await this.hasUsableComposer(page)) return null;
    for (const selector of this.loginSelectors) {
      const locator = page.locator(selector).first();
      try {
        if ((await locator.count()) > 0 && await locator.isVisible()) {
          return { reason: "selector", selector, url: page.url() };
        }
      } catch {
        // Try the next selector.
      }
    }
    return null;
  }

  async assertAutomationReady(page, { phase = "unknown", allowSelectorFallback = true } = {}) {
    const verification = await this.detectHumanVerification(page);
    if (verification) {
      throw new AutomationError(
        "HUMAN_VERIFICATION_REQUIRED",
        `${this.label} requires manual human verification before automation can continue.`,
        { providerId: this.id, phase, ...verification }
      );
    }
    const login = await this.detectLoginRequired(page, { allowSelectorFallback });
    if (login) {
      throw new AutomationError("LOGIN_REQUIRED", `${this.label} requires login before automation can continue.`, {
        providerId: this.id,
        phase,
        ...login,
      });
    }
  }

  async findComposer(page, { timeoutMs = 30000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      await this.assertAutomationReady(page, {
        phase: "find_composer",
        allowSelectorFallback: Date.now() - startedAt >= 750,
      });
      for (const selector of this.inputSelectors) {
        const locator = page.locator(selector);
        let count = 0;
        try {
          count = Math.min(await locator.count(), 20);
        } catch {
          continue;
        }
        for (let index = 0; index < count; index += 1) {
          const candidate = locator.nth(index);
          try {
            if (await candidate.isVisible() && await candidate.isEditable()) {
              await abortableDelay(180, signal);
              if (await candidate.isVisible() && await candidate.isEditable()) {
                return { locator: candidate, selector, index };
              }
            }
          } catch {
            // Provider pages frequently replace the composer while loading.
          }
        }
      }
      await abortableDelay(250, signal);
    }
    await this.assertAutomationReady(page, { phase: "find_composer_timeout" });
    throw new AutomationError("COMPOSER_NOT_FOUND", `Could not find a usable ${this.label} composer.`, {
      providerId: this.id,
      url: page.url(),
      selectors: this.inputSelectors,
    });
  }

  async insertPrompt(page, composer, prompt) {
    try {
      if (!(await composer.locator.isVisible()) || !(await composer.locator.isEditable())) {
        throw new AutomationError("COMPOSER_STALE", `The ${this.label} composer changed before prompt insertion.`, {
          providerId: this.id,
          selector: composer.selector,
        });
      }
      // Ad/feature promo overlays (e.g. doubao's "多条消息支持列队发送" modal,
      // observed 2026-09-15) intercept pointer events over the composer.
      // Dismiss proactively before touching the page instead of waiting for
      // the click to fail; the reactive dismissal below remains as fallback.
      await this.dismissBlockingOverlay(page);
      await composer.locator.scrollIntoViewIfNeeded();
      try {
        await composer.locator.click({ timeout: 5000 });
      } catch (clickError) {
        // Transient promo/dialog overlays can intercept pointer events before
        // the click lands (doubao radix dialog observed 2026-09-15 caused
        // COMPOSER_STALE). Try to dismiss the overlay once, then retry.
        const dismissed = await this.dismissBlockingOverlay(page);
        if (!dismissed) throw clickError;
        if (!(await composer.locator.isVisible()) || !(await composer.locator.isEditable())) {
          throw clickError;
        }
        await composer.locator.click({ timeout: 5000 });
      }
      await composer.locator.fill(prompt, { timeout: 10000 });
    } catch (error) {
      if (error instanceof AutomationError) throw error;
      throw new AutomationError("COMPOSER_STALE", `The ${this.label} composer changed during prompt insertion.`, {
        providerId: this.id,
        selector: composer.selector,
        cause: error.message,
      });
    }
    const inserted = String(await composer.locator.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
      return element.innerText || element.textContent || "";
    })).replace(/\s+/g, " ").trim();
    const expected = String(prompt).replace(/\s+/g, " ").trim();
    if (!inserted || !inserted.includes(expected.slice(0, Math.min(60, expected.length)))) {
      throw new AutomationError("PROMPT_INSERT_FAILED", `The ${this.label} composer did not retain the prompt.`, {
        providerId: this.id,
        selector: composer.selector,
        insertedPreview: inserted.slice(0, 160),
        expectedPreview: expected.slice(0, 160),
      });
    }
  }

  async dismissBlockingOverlay(page) {
    const overlaySelectors = [
      "[role='dialog']",
      "[data-slot='dialog-content']",
      "[class*='dialogMask']",
      "[class*='modal-mask']",
    ];
    for (const selector of overlaySelectors) {
      const locator = page.locator(selector).first();
      try {
        if (!(await locator.count()) || !(await locator.isVisible())) continue;
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        if (!(await locator.isVisible())) return true;
        const close = locator.locator(
          "button[aria-label*='close' i], button[aria-label*='关闭'], [class*='close']",
        ).first();
        try {
          if (await close.isVisible()) {
            await close.click({ timeout: 1500 });
            await page.waitForTimeout(500);
            if (!(await locator.isVisible())) return true;
          }
        } catch {
          // fall through to the next overlay selector
        }
      } catch {
        // ignore this selector and keep trying
      }
    }
    return false;
  }

  async submit(page, composer, { timeoutMs = 10000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      for (const selector of this.submitSelectors) {
        const locator = page.locator(selector).first();
        try {
          if ((await locator.count()) > 0 && await locator.isVisible() && await locator.isEnabled()) {
            await locator.click({ timeout: 5000 });
            return { method: "click", selector };
          }
        } catch {
          // Continue because send controls are often replaced after input events.
        }
      }
      await abortableDelay(200, signal);
    }
    try {
      await composer.locator.press("Enter", { timeout: 5000 });
      return { method: "keyboard", selector: composer.selector };
    } catch (error) {
      throw new AutomationError("SUBMIT_FAILED", `Could not submit the ${this.label} prompt.`, {
        providerId: this.id,
        cause: error.message,
        selectors: this.submitSelectors,
      });
    }
  }

  async collectResponseCandidates(page) {
    const candidates = [];
    const seen = new Set();
    for (const selector of this.responseSelectors) {
      const locator = page.locator(selector);
      let count = 0;
      try {
        count = Math.min(await locator.count(), 60);
      } catch {
        continue;
      }
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        try {
          if (!(await item.isVisible())) continue;
          const text = normalizeResponseText(await item.innerText({ timeout: 1200 }));
          if (!text) continue;
          const identity = await item.evaluate((element) => {
            const owner = element.closest(
              "[data-message-id], [data-testid^='conversation-turn-'], [data-observe-row], article"
            ) || element;
            const testId = owner.getAttribute("data-testid");
            const stable = owner.getAttribute("data-message-id")
              || owner.getAttribute("data-observe-row")
              || (testId?.startsWith("conversation-turn-") ? testId : null);
            if (stable) return stable;
            window.__webAgentsResponseIdentity ||= { sequence: 0, elements: new WeakMap() };
            let generated = window.__webAgentsResponseIdentity.elements.get(owner);
            if (!generated) {
              window.__webAgentsResponseIdentity.sequence += 1;
              generated = `web-agents-response-${window.__webAgentsResponseIdentity.sequence}`;
              window.__webAgentsResponseIdentity.elements.set(owner, generated);
            }
            return generated;
          });
          if (seen.has(identity)) continue;
          seen.add(identity);
          candidates.push({ selector, index, identity, text });
        } catch {
          // Streaming nodes can detach between count and innerText.
        }
      }
    }
    return candidates;
  }

  async isBusy(page) {
    for (const selector of this.busySelectors) {
      const locator = page.locator(selector).first();
      try {
        if ((await locator.count()) > 0 && await locator.isVisible()) return true;
      } catch {
        // Try the next selector.
      }
    }
    return false;
  }

  async isLoginRequired(page) {
    return Boolean(await this.detectLoginRequired(page));
  }

  async isHumanVerificationRequired(page) {
    return Boolean(await this.detectHumanVerification(page));
  }
}
