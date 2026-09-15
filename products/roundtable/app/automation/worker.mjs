import fs from "node:fs/promises";
import path from "node:path";

import { waitForCompletedResponse } from "./completion-detector.mjs";
import { AutomationError, throwIfAborted } from "./errors.mjs";
import { ProviderConcurrency } from "./provider-concurrency.mjs";

function safeName(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100);
}

function pageUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function writeDiagnostics({ page, adapter, request, error }) {
  if (!request.diagnosticsDir) return null;
  await fs.mkdir(request.diagnosticsDir, { recursive: true });
  const prefix = `${new Date().toISOString().replace(/[:.]/g, "")}-${safeName(request.providerId)}-${safeName(request.turnId)}`;
  const screenshotPath = path.join(request.diagnosticsDir, `${prefix}.png`);
  const htmlPath = path.join(request.diagnosticsDir, `${prefix}.html`);
  const metadataPath = path.join(request.diagnosticsDir, `${prefix}.json`);
  const files = { metadataPath };
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    files.screenshotPath = screenshotPath;
  } catch {
    // A closed page cannot provide a screenshot.
  }
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(htmlPath, html.slice(0, 500000), "utf8").catch(() => {});
    files.htmlPath = htmlPath;
  }
  const metadata = {
    at: new Date().toISOString(),
    sessionId: request.sessionId,
    planId: request.planId,
    turnId: request.turnId,
    providerId: request.providerId,
    url: page.url(),
    title: await page.title().catch(() => ""),
    error: {
      code: error?.code || "PROVIDER_EXECUTION_FAILED",
      message: error?.message || String(error),
      stack: error?.stack || null,
      details: error?.details || null,
    },
    adapter: adapter.describe(),
    files,
  };
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return files;
}

export class BrowserWorker {
  constructor({ manager, adapters, concurrency = null } = {}) {
    if (!manager) throw new Error("BROWSER_MANAGER_REQUIRED");
    this.manager = manager;
    this.adapters = adapters || manager.adapters;
    this.concurrency = concurrency || new ProviderConcurrency();
  }

  async execute(request) {
    return this.concurrency.run(
      request.providerId,
      request.threadKey || request.providerId,
      () => this.executeOnce(request),
      { signal: request.signal }
    );
  }

  async executeOnce(request) {
    const adapter = this.adapters.get(request.providerId);
    if (!adapter) {
      throw new AutomationError("UNSUPPORTED_PROVIDER", `No MVP browser adapter exists for ${request.providerId}.`, {
        providerId: request.providerId,
      });
    }
    if (!String(request.prompt || "").trim()) throw new AutomationError("EMPTY_PROMPT", "Browser worker received an empty prompt.");
    throwIfAborted(request.signal);
    const executionId = request.executionId || `turn:${request.sessionId || "session"}:${request.turnId || "turn"}`;
    let lease = null;
    let page;
    let onPopup = null;
    let resolveCapturePage = null;
    const assertLease = () => this.manager.assertPageLease?.(request.providerId, {
      threadKey: request.threadKey || null,
      executionId,
      leaseEpoch: lease?.leaseEpoch,
    });
    const heartbeatLease = () => Promise.resolve(this.manager.heartbeatPageLease?.(request.providerId, {
      threadKey: request.threadKey || null,
      executionId,
      leaseEpoch: lease?.leaseEpoch,
    }));
    const releaseLease = () => Promise.resolve(this.manager.releasePageLease?.(request.providerId, {
      threadKey: request.threadKey || null,
      executionId,
      leaseEpoch: lease?.leaseEpoch,
    })).catch(() => {});
    if (this.manager.leaseRegistry && this.manager.acquirePage) {
      ({ page, lease } = await this.manager.acquirePage(request.providerId, {
        threadKey: request.threadKey || null,
        executionId,
      }));
    } else {
      page = await this.manager.getPage(request.providerId, { threadKey: request.threadKey || null });
    }
    const heartbeatIntervalMs = Math.min(30000, Math.max(5000, Math.floor((this.manager.leaseRegistry?.leaseTtlMs || 120000) / 3)));
    const heartbeatTimer = lease
      ? setInterval(() => { void heartbeatLease().catch(() => {}); }, heartbeatIntervalMs)
      : null;
    heartbeatTimer?.unref?.();
    try {
      await assertLease();
      await request.checkpoint?.("prepared", { providerId: request.providerId, threadKey: request.threadKey || null });
      const composerTimeout = Math.min(30000, Math.max(1000, Math.floor((request.timeoutMs || 180000) / 3)));
      let baseline;
      let composer;
      let lastPreSubmitError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfAborted(request.signal);
        if (page.isClosed()) {
          this.manager.forgetPage(request.providerId, page, { threadKey: request.threadKey || null });
          page = await this.manager.getPage(request.providerId, { threadKey: request.threadKey || null });
        }
        try {
          await assertLease();
          baseline = await adapter.collectResponseCandidates(page);
          composer = await adapter.findComposer(page, { timeoutMs: composerTimeout, signal: request.signal });
          await adapter.insertPrompt(page, composer, request.prompt);
          lastPreSubmitError = null;
          break;
        } catch (error) {
          lastPreSubmitError = error;
          const retryable = error?.code === "COMPOSER_STALE" || page.isClosed() || /page, context or browser has been closed/i.test(error.message);
          if (!retryable || attempt === 1) throw error;
          if (page.isClosed()) {
            this.manager.forgetPage(request.providerId, page, { threadKey: request.threadKey || null });
            page = await this.manager.getPage(request.providerId, { threadKey: request.threadKey || null });
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (lastPreSubmitError || !composer) throw lastPreSubmitError || new AutomationError("COMPOSER_NOT_FOUND", "Composer retry failed.");
      await adapter.assertAutomationReady(page, { phase: "before_submit" });
      await assertLease();
      if (!request.autoSend) {
        throw new AutomationError("MANUAL_SEND_REQUIRED", `${adapter.label} prompt is inserted and waiting for manual send.`, {
          providerId: adapter.id,
        });
      }
      await request.checkpoint?.("submitting", { providerId: request.providerId, threadKey: request.threadKey || null });
      // Some providers (e.g. Kimi) move the submitted conversation into a newly
      // opened tab while the original tab falls back to the site homepage, so
      // the response capture must follow pages opened by the submission itself.
      const submissionOrigin = pageUrlOrigin(page.url()) || pageUrlOrigin(adapter.url);
      const openedPages = [];
      onPopup = (popupPage) => {
        if (!popupPage) return;
        const popupOrigin = pageUrlOrigin(popupPage.url());
        if (submissionOrigin && popupOrigin && popupOrigin !== submissionOrigin) return;
        openedPages.push(popupPage);
      };
      page.on?.("popup", onPopup);
      let followPage = null;
      resolveCapturePage = () => {
        if (followPage && !followPage.isClosed()) return followPage;
        followPage = null;
        while (openedPages.length > 0) {
          const candidate = openedPages[openedPages.length - 1];
          if (!candidate.isClosed()) {
            followPage = candidate;
            break;
          }
          openedPages.pop();
        }
        return followPage || page;
      };
      const submission = await adapter.submit(page, composer, {
        timeoutMs: Math.min(12000, composerTimeout),
        signal: request.signal,
      });
      await request.checkpoint?.("submitted", { providerId: request.providerId, threadKey: request.threadKey || null, url: page.url() });
      if (!request.autoCapture) {
        throw new AutomationError("MANUAL_CAPTURE_REQUIRED", `${adapter.label} prompt was sent and is waiting for manual capture.`, {
          providerId: adapter.id,
        });
      }
      await request.onCaptureStart?.({ providerId: request.providerId, threadKey: request.threadKey || null });
      const capture = await waitForCompletedResponse({
        page,
        adapter,
        resolvePage: resolveCapturePage,
        baselineCandidates: baseline,
        timeoutMs: request.timeoutMs || 180000,
        settleMs: request.settleMs || 3000,
        onProgress: this.manager.leaseRegistry
          ? async (progress) => {
            await heartbeatLease();
            return request.onProgress?.(progress);
          }
          : request.onProgress,
        signal: request.signal,
      });
      await assertLease();
      await request.checkpoint?.("captured", { providerId: request.providerId, threadKey: request.threadKey || null, settledAt: capture.settledAt });
      return {
        providerId: request.providerId,
        text: capture.text,
        capture: {
          selector: capture.selector,
          index: capture.index,
          identity: capture.identity || null,
          domIdentity: capture.identity || null,
          providerMessageId: capture.providerMessageId || capture.messageId || null,
          conversationId: capture.conversationId || null,
          replyToUserMessageId: capture.replyToUserMessageId || capture.userMessageId || null,
          role: capture.role || capture.speaker || "assistant",
          status: capture.status || (capture.complete === false ? "streaming" : "complete"),
          observedBusy: capture.observedBusy,
          settledAt: capture.settledAt,
          url: (followPage && !followPage.isClosed() ? followPage : page).url(),
          submission,
        },
      };
    } catch (error) {
      let classifiedError = error;
      const leaseRejected = String(error?.code || "").startsWith("PAGE_LEASE_");
      if (!request.signal?.aborted && !leaseRejected && !["LOGIN_REQUIRED", "HUMAN_VERIFICATION_REQUIRED"].includes(error?.code)) {
        try {
          await adapter.assertAutomationReady(page, { phase: "error_reclassification" });
        } catch (blockingError) {
          if (["LOGIN_REQUIRED", "HUMAN_VERIFICATION_REQUIRED"].includes(blockingError?.code)) {
            classifiedError = blockingError;
          }
        }
      }
      const diagnostics = leaseRejected
        ? null
        : await writeDiagnostics({ page: resolveCapturePage ? resolveCapturePage() : page, adapter, request, error: classifiedError });
      if (["LOGIN_REQUIRED", "HUMAN_VERIFICATION_REQUIRED"].includes(classifiedError?.code)) {
        this.manager.forgetPage(request.providerId, page, { threadKey: request.threadKey || null });
      }
      this.concurrency.reportSignal(request.providerId, classifiedError?.code);
      if (classifiedError instanceof AutomationError) {
        classifiedError.diagnostics = diagnostics;
        classifiedError.details = { ...(classifiedError.details || {}), diagnostics };
        throw classifiedError;
      }
      throw new AutomationError("PROVIDER_EXECUTION_FAILED", `${adapter.label} automation failed: ${classifiedError.message}`, {
        providerId: request.providerId,
        cause: classifiedError.message,
        diagnostics,
      });
    } finally {
      if (onPopup && page.off) {
        try { page.off("popup", onPopup); } catch {}
      }
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await releaseLease();
    }
  }
}

export { writeDiagnostics };
