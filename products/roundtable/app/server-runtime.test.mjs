import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { createRoundtableServer, createSession as createStoredSession } from "./server.mjs";
import { RoundtableScheduler } from "./orchestrator/scheduler.mjs";
import { LocalWorkspaceStore } from "./storage/local-workspace-store.mjs";
import { createHash } from "node:crypto";
import { compressSessionContext } from "./orchestrator/context-compressor.mjs";
import { CommandTransferRegistry } from "./orchestrator/command-transfer.mjs";

async function startServer(t, options = {}) {
  const repoRoot = options.repoRoot || await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-server-runtime-"));
  const server = createRoundtableServer({ repoRoot, browserMode: "cdp", ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await server.runtime.browserManager.close();
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await closed;
  });
  const { port } = server.address();
  return { repoRoot, server, baseUrl: `http://127.0.0.1:${port}` };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", Connection: "close", ...(options.headers || {}) },
  });
  const payload = await response.json();
  return { response, payload };
}

async function rawHttpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, payload: text ? JSON.parse(text) : null });
      });
    });
    request.on("error", reject);
    request.end(options.body || undefined);
  });
}

async function createSession(baseUrl, settings = {}, { openThreads = false } = {}) {
  const { payload } = await jsonRequest(`${baseUrl}/api/sessions`, {
    method: "POST",
    body: JSON.stringify({
      title: "Runtime integration",
      objective: "验证真实后台链路",
      participants: ["chatgpt", "deepseek", "doubao"],
      settings,
      openThreads,
    }),
  });
  assert.equal(payload.ok, true);
  return payload.session;
}

async function waitForSession(baseUrl, sessionId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, { headers: { Connection: "close" } }).then((response) => response.json());
    if (predicate(payload.session)) return payload.session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("SESSION_WAIT_TIMEOUT");
}

test("local API exposes verifiable identity and rejects remote browser origins", async (t) => {
  const { baseUrl, repoRoot, server } = await startServer(t);
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.service, "web-agents-roundtable");
  assert.equal(health.pid, process.pid);
  assert.equal(health.repoRoot, path.resolve(repoRoot));
  assert.equal(health.port, server.address().port);
  assert.equal(health.browser.mode, "cdp");
  assert.equal(health.browser.connected, false);
  assert.equal(healthResponse.headers.get("access-control-allow-origin"), null);

  const sameOrigin = await fetch(`${baseUrl}/api/health`, { headers: { Origin: baseUrl } });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.headers.get("access-control-allow-origin"), baseUrl);

  const remoteOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "https://chat.deepseek.com" },
  });
  assert.equal(remoteOrigin.status, 403);
  assert.equal((await remoteOrigin.json()).error, "LOCAL_ORIGIN_REQUIRED");

  const wrongPortOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "http://127.0.0.1:9" },
  });
  assert.equal(wrongPortOrigin.status, 403);
  assert.equal((await wrongPortOrigin.json()).error, "LOCAL_ORIGIN_REQUIRED");

  const preflight = await fetch(`${baseUrl}/api/sessions`, {
    method: "OPTIONS",
    headers: { Origin: baseUrl, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), baseUrl);
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);

  const remoteHost = await rawHttpRequest(`${baseUrl}/api/health`, { headers: { Host: "example.com" } });
  assert.equal(remoteHost.status, 403);
  assert.equal(remoteHost.payload.error, "LOCAL_HOST_REQUIRED");

  const wrongContentType = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongContentType.status, 415);
  assert.equal((await wrongContentType.json()).error, "APPLICATION_JSON_REQUIRED");
});

test("discussion role and intervention APIs persist ordered editable queue state", async (t) => {
  const { baseUrl, server } = await startServer(t, { sqliteControlEnabled: false });
  const session = await createSession(baseUrl, { conversationMode: "discussion", mode: "mock", defaultRounds: 5 }, { openThreads: false });
  const prepared = await server.runtime.scheduler.prepareCommand(session.id, {
    text: "如何进行自学",
    targets: ["chatgpt", "deepseek", "doubao"],
    mentionTokens: [],
    rounds: 5,
  });

  const role = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/participant-role`, {
    method: "POST",
    body: JSON.stringify({ providerId: "deepseek", role: "学习科学研究者" }),
  });
  assert.equal(role.response.status, 200);
  assert.equal(role.payload.session.participantRoles.deepseek, "学习科学研究者");
  const invalidRole = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/participant-role`, {
    method: "POST",
    body: JSON.stringify({ providerId: "qwen", role: "旁观者" }),
  });
  assert.equal(invalidRole.response.status, 404);

  const first = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/interventions`, {
    method: "POST",
    body: JSON.stringify({ planId: prepared.plan.id, content: "先考虑时间限制" }),
  });
  const second = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/interventions`, {
    method: "POST",
    body: JSON.stringify({ planId: prepared.plan.id, content: "再考虑反馈周期" }),
  });
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);

  const edited = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/interventions/${first.payload.intervention.id}`, {
    method: "PATCH",
    body: JSON.stringify({ content: "优先考虑每天可用时间" }),
  });
  assert.equal(edited.response.status, 200);
  const reloaded = await fetch(`${baseUrl}/api/sessions/${session.id}`, { headers: { Connection: "close" } }).then((response) => response.json());
  assert.deepEqual(reloaded.session.pendingInterventions.map((item) => item.content), [
    "优先考虑每天可用时间",
    "再考虑反馈周期",
  ]);

  const removed = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/interventions/${second.payload.intervention.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.response.status, 200);
  await server.runtime.store.updateSession(session.id, (current) => {
    current.pendingInterventions = [];
    return current;
  });
  const consumedEdit = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/interventions/${first.payload.intervention.id}`, {
    method: "PATCH",
    body: JSON.stringify({ content: "不能再改" }),
  });
  assert.equal(consumedEdit.response.status, 409);
});

test("continuation API adds exactly one discussion cycle and enforces the cap", async (t) => {
  const { baseUrl, server } = await startServer(t, {
    sqliteControlEnabled: false,
    worker: {
      async execute(request) {
        return { text: request.round === 1 ? "恢复后的第一周期观点" : "PASS" };
      },
    },
  });
  const session = await createSession(baseUrl, { conversationMode: "discussion", mode: "mock", defaultRounds: 5 }, { openThreads: false });
  const prepared = await server.runtime.scheduler.prepareCommand(session.id, {
    text: "继续讨论",
    targets: ["chatgpt"],
    mentionTokens: [],
    rounds: 5,
  });
  await server.runtime.store.updateSession(session.id, (current) => {
    const plan = current.plans.find((candidate) => candidate.id === prepared.plan.id);
    plan.status = "awaiting_continuation";
    plan.maxCycles = 10;
    current.runtime.status = "awaiting_continuation";
    return current;
  });
  const capped = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/plans/${prepared.plan.id}/continue`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(capped.response.status, 409);

  await server.runtime.store.updateSession(session.id, (current) => {
    const plan = current.plans.find((candidate) => candidate.id === prepared.plan.id);
    plan.status = "awaiting_continuation";
    plan.maxCycles = 5;
    plan.rounds = 5;
    current.runtime.status = "awaiting_continuation";
    return current;
  });
  const continued = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/plans/${prepared.plan.id}/continue`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(continued.response.status, 202);
  assert.equal(continued.payload.plan.maxCycles, 6);
  assert.equal(continued.payload.session.runtime.status, "running");
  assert.equal(continued.payload.run.status, "running");
  const completed = await waitForSession(
    baseUrl,
    session.id,
    (current) => current.plans.find((plan) => plan.id === prepared.plan.id)?.status === "completed",
    10000,
  );
  assert.equal(completed.runtime.status, "idle");
  const runDeadline = Date.now() + 3000;
  while (server.runtime.runRegistry.get(continued.payload.run.runId)?.status !== "completed" && Date.now() < runDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(server.runtime.runRegistry.get(continued.payload.run.runId)?.status, "completed");
});

test("roundtable serves pinned markdown and sanitizer browser assets locally", async (t) => {
  const { baseUrl } = await startServer(t);
  const [markedResponse, purifyResponse] = await Promise.all([
    fetch(`${baseUrl}/vendor/marked.umd.js`),
    fetch(`${baseUrl}/vendor/purify.min.js`),
  ]);

  assert.equal(markedResponse.status, 200);
  assert.match(markedResponse.headers.get("content-type"), /javascript/);
  assert.match(await markedResponse.text(), /marked/);
  assert.equal(purifyResponse.status, 200);
  assert.match(purifyResponse.headers.get("content-type"), /javascript/);
  assert.match(await purifyResponse.text(), /DOMPurify/);
});

test("unknown internal NOT_FOUND messages remain server errors", async (t) => {
  const browserManager = {
    mode: "cdp",
    profileDir: "test-profile",
    status() { return { mode: "cdp", connected: false, bindings: [], pages: [] }; },
    async connect() { throw new Error("INTERNAL_CONFIG_NOT_FOUND_DURING_RECOVERY"); },
    async close() {},
  };
  const { baseUrl } = await startServer(t, { browserManager });

  const result = await jsonRequest(`${baseUrl}/api/browser/connect`, {
    method: "POST",
    body: JSON.stringify({ providers: [] }),
  });

  assert.equal(result.response.status, 500);
  assert.equal(result.payload.error, "INTERNAL_CONFIG_NOT_FOUND_DURING_RECOVERY");
});

test("session thread provisioning preserves every participant outcome", async (t) => {
  let releaseProvisioning;
  const provisioningStarted = [];
  const allStarted = new Promise((resolve) => { releaseProvisioning = resolve; });
  const browserManager = {
    mode: "cdp",
    status() {
      return { mode: "cdp", connected: false, bindings: [], pages: [] };
    },
    async createProviderThread(providerId) {
      provisioningStarted.push(providerId);
      if (provisioningStarted.length === 2) releaseProvisioning();
      await Promise.race([
        allStarted,
        new Promise((resolve) => setTimeout(resolve, 60)),
      ]);
      const error = new Error("browser unavailable");
      error.code = "MANUAL_BROWSER_UNAVAILABLE";
      throw error;
    },
    async close() {},
  };
  const { baseUrl } = await startServer(t, {
    browserManager,
    worker: { async execute() { throw new Error("NOT_USED"); } },
  });

  const created = await jsonRequest(`${baseUrl}/api/sessions`, {
    method: "POST",
    body: JSON.stringify({
      participants: ["deepseek", "doubao"],
      settings: { mode: "playwright", defaultRounds: 1 },
    }),
  });

  assert.equal(created.response.status, 201);
  assert.deepEqual(provisioningStarted.sort(), ["deepseek", "doubao"]);
  assert.equal(created.payload.session.threads.deepseek.status, "waiting_browser");
  assert.equal(created.payload.session.threads.doubao.status, "waiting_browser");
});

test("static ES modules are served with a JavaScript MIME type", async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(`${baseUrl}/composer-model.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/javascript/);
});

test("extension runtime rejects a session configured for the CDP browser mode", async (t) => {
  const { baseUrl } = await startServer(t, { browserMode: "extension" });
  const session = await createSession(baseUrl, {
    mode: "playwright",
    conversationMode: "discussion",
    defaultRounds: 1,
  });

  const result = await jsonRequest(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/commands`, {
    method: "POST",
    body: JSON.stringify({ text: "@gpt This command must be rejected before execution" }),
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, "BROWSER_MODE_MISMATCH");
});

test("direct server startup rejects a custom port in extension mode", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      WEB_AGENTS_BROWSER_MODE: "extension",
      WEB_AGENTS_ROUNDTABLE_PORT: "3021",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "exit");

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /Extension mode requires port 3020/);
});

test("manual browser API connects and binds only an existing user-owned tab", async (t) => {
  const calls = [];
  const browserState = {
    mode: "cdp",
    connected: false,
    started: false,
    cdpEndpoint: "http://127.0.0.1:9223",
    bindings: [],
    pages: [],
  };
  const browserManager = {
    status() { return structuredClone(browserState); },
    async connect() {
      calls.push({ action: "connect" });
      browserState.connected = true;
      browserState.started = true;
    },
    async bindProviderPage(providerId, url) {
      calls.push({ action: "bind", providerId, url });
      const binding = {
        providerId,
        status: "verified",
        url: "https://chatgpt.com/c/manual-tab",
        title: "ChatGPT",
      };
      browserState.bindings = [{ ...binding, closed: false }];
      browserState.pages = [...browserState.bindings];
      return binding;
    },
    unbindProvider(providerId) {
      calls.push({ action: "unbind", providerId });
      browserState.bindings = [];
      browserState.pages = [];
      return true;
    },
    async openProviders() {
      const error = new Error("Provider pages must be opened manually by the user.");
      error.code = "MANUAL_BROWSER_NAVIGATION_DISABLED";
      throw error;
    },
    async close() {},
  };
  const { baseUrl } = await startServer(t, { browserManager });

  const connected = await jsonRequest(`${baseUrl}/api/browser/connect`, { method: "POST", body: "{}" });
  assert.equal(connected.response.status, 200);
  assert.equal(connected.payload.browser.connected, true);

  const bound = await jsonRequest(`${baseUrl}/api/browser/bind`, {
    method: "POST",
    body: JSON.stringify({ providerId: "chatgpt", url: "https://chatgpt.com/c/manual-tab?secret=value#private" }),
  });
  assert.equal(bound.response.status, 200);
  assert.deepEqual(bound.payload.binding, {
    providerId: "chatgpt",
    status: "verified",
    url: "https://chatgpt.com/c/manual-tab",
  });
  assert.deepEqual(calls.at(-1), {
    action: "bind",
    providerId: "chatgpt",
    url: "https://chatgpt.com/c/manual-tab?secret=value#private",
  });

  const unbound = await jsonRequest(`${baseUrl}/api/browser/unbind`, {
    method: "POST",
    body: JSON.stringify({ providerId: "chatgpt" }),
  });
  assert.equal(unbound.response.status, 200);
  assert.equal(unbound.payload.removed, true);

  const legacyOpen = await jsonRequest(`${baseUrl}/api/browser/open`, {
    method: "POST",
    body: JSON.stringify({ providers: ["chatgpt"] }),
  });
  assert.equal(legacyOpen.response.status, 409);
  assert.equal(legacyOpen.payload.code, "MANUAL_BROWSER_NAVIGATION_DISABLED");
});

test("extension relay API carries one allowlisted command through the local roundtable page", async (t) => {
  const { baseUrl, server } = await startServer(t);
  const clientId = "roundtable-client-12345678";
  const registered = await jsonRequest(`${baseUrl}/api/extension/register`, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      available: true,
      extensionVersion: "0.1.0",
      bridgeRevision: "legacy-sidecar-v1",
      token: "must-not-cross",
    }),
  });
  assert.equal(registered.response.status, 200);
  assert.equal(registered.payload.extensionBridge.connected, true);
  assert.equal(registered.payload.client.extensionVersion, "0.1.0");
  assert.equal(registered.payload.client.bridgeRevision, "legacy-sidecar-v1");
  assert.equal(Object.hasOwn(registered.payload.client, "token"), false);

  const completion = server.runtime.extensionRelay.dispatch({
    type: "tabs:probe-provider",
    provider: "chatgpt",
  });
  const polled = await fetch(`${baseUrl}/api/extension/poll?clientId=${encodeURIComponent(clientId)}`).then((response) => response.json());
  assert.equal(polled.command.request.type, "tabs:probe-provider");
  assert.equal(polled.command.request.provider, "chatgpt");

  const result = await jsonRequest(`${baseUrl}/api/extension/result`, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      commandId: polled.command.commandId,
      result: {
        ok: true,
        type: "tabs:probe-provider",
        data: {
          provider: "chatgpt",
          authenticated: true,
          reason: "authenticated",
          tabId: 42,
          label: "ChatGPT",
          url: "https://chatgpt.com/c/roundtable",
          readiness: "supported",
          canInsert: true,
          ready: true,
          verificationRequired: false,
        },
      },
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.completion.completed, true);
  assert.equal((await completion).data.authenticated, true);

  const status = await fetch(`${baseUrl}/api/extension/status`).then((response) => response.json());
  assert.equal(status.extensionBridge.pendingCommands, 0);
  assert.equal("request" in status.extensionBridge.clients[0], false);
  assert.equal(status.extensionBridge.clients[0].bridgeRevision, "legacy-sidecar-v1");

  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  assert.equal(health.extensionBridge.clients[0].extensionVersion, "0.1.0");
  assert.equal(health.extensionBridge.clients[0].bridgeRevision, "legacy-sidecar-v1");
});

test("extension relay API rejects a disallowed command without exposing it to a client", async (t) => {
  const { baseUrl, server } = await startServer(t);
  const clientId = "roundtable-client-12345678";
  await jsonRequest(`${baseUrl}/api/extension/register`, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      available: true,
      extensionVersion: "0.1.0",
      bridgeRevision: "legacy-sidecar-v1",
    }),
  });

  await assert.rejects(
    server.runtime.extensionRelay.dispatch({ type: "mcp:execute-tool-call" }),
    (error) => error.code === "EXTENSION_REQUEST_NOT_ALLOWED"
  );
  const polled = await fetch(`${baseUrl}/api/extension/poll?clientId=${encodeURIComponent(clientId)}`).then((response) => response.json());
  assert.equal(polled.command, null);
});

test("extension relay API rejects an incompatible available bridge client", async (t) => {
  const { baseUrl } = await startServer(t);
  const registered = await jsonRequest(`${baseUrl}/api/extension/register`, {
    method: "POST",
    body: JSON.stringify({
      clientId: "roundtable-incompatible-client",
      available: true,
      extensionVersion: "0.0.9",
      bridgeRevision: "legacy-sidecar-v1",
    }),
  });

  assert.equal(registered.response.status, 409);
  assert.equal(registered.payload.code, "EXTENSION_BRIDGE_INCOMPATIBLE");
  const status = await fetch(`${baseUrl}/api/extension/status`).then((response) => response.json());
  assert.equal(status.extensionBridge.connected, false);
});

test("extension runtime auto-binds a normal Chrome tab and completes a real scheduler turn through the relay", { timeout: 15000 }, async (t) => {
  const { baseUrl } = await startServer(t, { browserMode: "extension" });
  const clientId = "roundtable-extension-e2e";
  await jsonRequest(`${baseUrl}/api/extension/register`, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      available: true,
      extensionVersion: "0.1.0",
      bridgeRevision: "legacy-sidecar-v1",
    }),
  });

  const providerTab = {
    provider: "chatgpt",
    authenticated: true,
    reason: "authenticated",
    tabId: 42,
    label: "ChatGPT",
    url: "https://chatgpt.com/c/extension-e2e",
    readiness: "supported",
    canInsert: true,
    ready: true,
    verificationRequired: false,
  };

  async function pollCommand(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const payload = await fetch(`${baseUrl}/api/extension/poll?clientId=${encodeURIComponent(clientId)}`).then((response) => response.json());
      if (payload.command) return payload.command;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error("EXTENSION_TEST_COMMAND_TIMEOUT");
  }

  async function answer(command) {
    const type = command.request.type;
    const data = type === "tabs:discover-providers"
      ? { tabs: [providerTab] }
      : type === "tab:auth-probe"
        ? { provider: "chatgpt", authenticated: true, reason: "authenticated" }
        : type === "tab:detect"
          ? {
              provider: "chatgpt",
              label: "ChatGPT",
              readiness: "supported",
              canInsert: true,
              verificationRequired: false,
              tabId: 42,
              url: "https://chatgpt.com/c/extension-e2e",
            }
        : type === "tab:capture-recent"
          ? { provider: "chatgpt", capturedAt: new Date().toISOString(), messages: [{ speaker: "assistant", text: "Old response", source: "article" }] }
        : type === "tab:auto-send-text"
            ? { provider: "chatgpt", state: "sent", message: "sent through extension" }
            : type === "tab:capture-latest"
              ? { provider: "chatgpt", speaker: "assistant", text: "Extension-backed roundtable reply", capturedAt: new Date().toISOString(), source: "article" }
              : null;
    assert.notEqual(data, null, `unexpected extension command ${type}`);
    const result = await jsonRequest(`${baseUrl}/api/extension/result`, {
      method: "POST",
      body: JSON.stringify({
        clientId,
        commandId: command.commandId,
        result: { ok: true, type, data },
      }),
    });
    assert.equal(result.response.status, 200);
  }

  const connectRequest = jsonRequest(`${baseUrl}/api/browser/connect`, { method: "POST", body: "{}" });
  await answer(await pollCommand());
  const connected = await connectRequest;
  assert.equal(connected.response.status, 200);
  assert.equal(connected.payload.browser.mode, "extension");
  assert.deepEqual(connected.payload.browser.bindings, [{
    providerId: "chatgpt",
    tabId: 42,
    url: "https://chatgpt.com/c/extension-e2e",
    status: "verified",
    authenticated: true,
    canInsert: true,
    closed: false,
  }]);

  const created = await jsonRequest(`${baseUrl}/api/sessions`, {
    method: "POST",
    body: JSON.stringify({
      title: "Extension E2E",
      objective: "Verify original Chrome relay",
      participants: ["chatgpt"],
      settings: {
        mode: "extension",
        conversationMode: "discussion",
        defaultRounds: 1,
        executionTimeoutMs: 5000,
        settleMs: 500,
        autoSend: true,
        autoCapture: true,
      },
    }),
  });
  const sessionId = created.payload.session.id;
  const started = await jsonRequest(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ text: "@gpt Reply through the extension" }),
  });
  assert.equal(started.response.status, 202);

  const deadline = Date.now() + 10000;
  let completedSession = null;
  let lastSession = null;
  while (Date.now() < deadline) {
    const sessionPayload = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`).then((response) => response.json());
    lastSession = sessionPayload.session;
    if (["completed", "failed"].includes(sessionPayload.session.plans?.at(-1)?.status)) {
      completedSession = sessionPayload.session;
      break;
    }
    const command = await pollCommand(300).catch(() => null);
    if (command) await answer(command);
  }

  assert.equal(completedSession?.plans?.at(-1)?.status, "completed", JSON.stringify({
    runtime: lastSession?.runtime,
    plan: lastSession?.plans?.at(-1),
  }));
  const reply = completedSession.events.find((event) => event.type === "reply");
  assert.equal(reply.content, "Extension-backed roundtable reply");
  assert.equal(reply.metadata.executionMode, "extension");
});

test("playwright command returns 202 and publishes completion through SSE", async (t) => {
  const worker = {
    async execute(request) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { text: `${request.providerId} real-worker reply` };
    },
  };
  const { baseUrl } = await startServer(t, { worker });
  const session = await createSession(baseUrl, {
    mode: "playwright",
    conversationMode: "discussion",
    defaultRounds: 1,
  });

  const sseController = new AbortController();
  t.after(() => sseController.abort());
  const sseResponse = await fetch(`${baseUrl}/api/events?sessionId=${encodeURIComponent(session.id)}`, {
    signal: sseController.signal,
  });
  assert.equal(sseResponse.status, 200);
  const reader = sseResponse.body.getReader();
  const seen = [];
  const consume = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop();
      for (const block of blocks) {
        const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
        if (eventLine) seen.push(eventLine.slice(7));
        if (seen.includes("plan.completed")) return;
      }
    }
  })();

  const command = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/commands`, {
    method: "POST",
    body: JSON.stringify({ text: "@ds 单独分析" }),
  });
  assert.equal(command.response.status, 202);
  assert.equal(command.payload.plan.status, "running");
  assert.equal(command.payload.run.status, "running");

  const completed = await waitForSession(baseUrl, session.id, (value) => value.plans.at(-1)?.status === "completed");
  let completionTimer;
  try {
    await Promise.race([
      consume,
      new Promise((_, reject) => {
        completionTimer = setTimeout(() => reject(new Error(`SSE_COMPLETION_TIMEOUT:${seen.join(",")}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(completionTimer);
    await reader.cancel().catch(() => {});
    sseController.abort();
  }
  assert.equal(completed.events.at(-1).content, "deepseek real-worker reply");
  assert.ok(seen.includes("turn.started"));
  assert.ok(seen.includes("turn.completed"));
  assert.ok(seen.includes("plan.completed"));
});

test("concurrent command HTTP requests accept only one active run", async (t) => {
  const worker = {
    async execute(request) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { text: `${request.providerId} concurrent reply` };
    },
  };
  const { baseUrl } = await startServer(t, { worker });
  const session = await createSession(baseUrl, { mode: "playwright", defaultRounds: 1 });
  const requests = await Promise.all([
    jsonRequest(`${baseUrl}/api/sessions/${session.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ text: "@gpt 第一个命令" }),
    }),
    jsonRequest(`${baseUrl}/api/sessions/${session.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ text: "@ds 第二个命令" }),
    }),
  ]);

  assert.deepEqual(requests.map(({ response }) => response.status).sort(), [202, 409]);
  const rejected = requests.find(({ response }) => response.status === 409);
  assert.equal(rejected.payload.error, "SESSION_RUN_ACTIVE");
  const completed = await waitForSession(baseUrl, session.id, (value) => value.runtime?.status === "idle");
  assert.equal(completed.plans.length, 1);
});

test("a first technical failure is retried automatically before manual recovery", async (t) => {
  let attempts = 0;
  const worker = {
    async execute(request) {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("composer moved"), { code: "COMPOSER_NOT_FOUND" });
      return { text: `${request.providerId} recovered` };
    },
  };
  const { baseUrl } = await startServer(t, { worker });
  const session = await createSession(baseUrl, { mode: "playwright", defaultRounds: 1 });
  const command = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/commands`, {
    method: "POST",
    body: JSON.stringify({ text: "@gpt 重试测试" }),
  });
  assert.equal(command.response.status, 202);
  const completed = await waitForSession(baseUrl, session.id, (value) => value.plans.at(-1)?.status === "completed");
  const turn = completed.plans.at(-1).turns[0];
  assert.equal(turn.status, "completed");
  assert.equal(turn.attempts, 2);
  assert.equal(turn.attemptErrors.length, 1);
  assert.equal(turn.attemptErrors[0].error.code, "COMPOSER_NOT_FOUND");
  assert.equal(attempts, 2);
});

test("storage APIs report the data root and reindex persisted sessions", async (t) => {
  const { repoRoot, baseUrl } = await startServer(t);
  await createSession(baseUrl, { mode: "mock" });
  const storage = await fetch(`${baseUrl}/api/storage`).then((response) => response.json());
  assert.equal(storage.ok, true);
  assert.equal(storage.storage.dataRoot, path.join(repoRoot, "generated", "roundtable-data"));

  const reindex = await jsonRequest(`${baseUrl}/api/storage/reindex`, { method: "POST", body: "{}" });
  assert.equal(reindex.payload.sessions.length, 1);
  const sessions = await fetch(`${baseUrl}/api/sessions`).then((response) => response.json());
  assert.equal(sessions.sessions.length, 1);
});

test("artifact HTTP APIs write and roll back a local file", async (t) => {
  const { repoRoot, baseUrl } = await startServer(t);
  const session = await createSession(baseUrl, { mode: "mock" });
  const target = path.join(repoRoot, "deliverables", "summary.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "before", "utf8");

  const write = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/artifacts`, {
    method: "POST",
    body: JSON.stringify({ path: target, content: "after", label: "验收总结" }),
  });
  assert.equal(write.response.status, 201);
  assert.equal(await fs.readFile(target, "utf8"), "after");

  const rollback = await jsonRequest(
    `${baseUrl}/api/sessions/${session.id}/artifacts/${write.payload.artifact.id}/rollback`,
    { method: "POST", body: "{}" }
  );
  assert.equal(rollback.payload.ok, true);
  assert.equal(await fs.readFile(target, "utf8"), "before");
});

test("transaction rollback route rejects another session's transaction", async (t) => {
  const { repoRoot, baseUrl } = await startServer(t);
  const owner = await createSession(baseUrl, { mode: "mock" });
  const other = await createSession(baseUrl, { mode: "mock" });
  const target = path.join(repoRoot, "deliverables", "session-owned.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "before", "utf8");

  const write = await jsonRequest(`${baseUrl}/api/sessions/${owner.id}/artifacts`, {
    method: "POST",
    body: JSON.stringify({ path: target, content: "after", label: "归属测试" }),
  });
  const transactionId = write.payload.artifact.transactionId;
  const rollback = await jsonRequest(
    `${baseUrl}/api/sessions/${other.id}/transactions/${transactionId}/rollback`,
    { method: "POST", body: "{}" },
  );

  assert.equal(rollback.response.status, 409);
  assert.equal(rollback.payload.code, "TRANSACTION_SESSION_MISMATCH");
  assert.equal(await fs.readFile(target, "utf8"), "after");
});

test("artifact HTTP API rejects workspace-external writes", async (t) => {
  const { repoRoot, baseUrl } = await startServer(t);
  const session = await createSession(baseUrl, { mode: "mock" });
  const target = path.join(path.dirname(repoRoot), `outside-${path.basename(repoRoot)}.md`);

  const write = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/artifacts`, {
    method: "POST",
    body: JSON.stringify({ path: target, content: "must not write" }),
  });
  assert.equal(write.response.status, 409);
  assert.equal(write.payload.code, "ARTIFACT_EXTERNAL_WRITE_REQUIRES_TOOL_LOOP");
  await assert.rejects(fs.access(target), /ENOENT/);
});

test("server startup fails an interrupted handoff while preserving the previous thread", async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-server-handoff-interrupted-"));
  const store = new LocalWorkspaceStore({ repoRoot });
  await store.initialize();
  const session = await createStoredSession({
    title: "Interrupted handoff",
    participants: ["deepseek"],
    settings: { mode: "playwright", defaultRounds: 1 },
  }, { store });
  const previousThread = structuredClone(session.threads.deepseek);
  session.handoffs = [{
    id: "interrupted-handoff",
    providerId: "deepseek",
    status: "sending_snapshot",
    previousThread,
    packet: { cutoffIndex: -1 },
  }];
  await store.saveSession(session);

  const { baseUrl } = await startServer(t, { repoRoot, store });
  await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  const reconciled = await fetch(`${baseUrl}/api/sessions/${session.id}`).then((response) => response.json());

  assert.equal(reconciled.session.handoffs[0].status, "failed");
  assert.equal(reconciled.session.handoffs[0].error.code, "HANDOFF_INTERRUPTED");
  assert.equal(reconciled.session.threads.deepseek.threadKey, previousThread.threadKey);
});

test("server recovery uses the latest session plan read under the store lock", async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-server-recovery-lock-"));
  const store = new LocalWorkspaceStore({ repoRoot });
  await store.initialize();
  const created = await createStoredSession({
    title: "Locked recovery",
    participants: ["deepseek"],
    settings: { mode: "playwright", defaultRounds: 1 },
  }, { store });
  const scheduler = new RoundtableScheduler({ store });
  const prepared = await scheduler.prepareCommand(created.id, { text: "@ds 恢复计划" }, { runId: "stale-run" });
  const live = await store.readSession(created.id);
  const stalePlan = live.plans.find((plan) => plan.id === prepared.plan.id);
  const staleTurn = stalePlan.turns.find((turn) => turn.countsTowardRounds);
  staleTurn.status = "waiting_recovery";
  stalePlan.status = "waiting_recovery";

  const latestPlan = structuredClone(stalePlan);
  latestPlan.id = "latest-plan";
  latestPlan.runId = "latest-run";
  latestPlan.turns = latestPlan.turns.map((turn, index) => ({
    ...turn,
    id: `latest-turn-${index}`,
  }));
  const latestTurn = latestPlan.turns.find((turn) => turn.countsTowardRounds);
  latestTurn.status = "waiting_recovery";
  live.plans = [stalePlan, latestPlan];
  live.runtime = {
    status: "waiting_recovery",
    activePlanId: latestPlan.id,
    activeRunId: "latest-run",
    failedTurnId: latestTurn.id,
    error: { code: "HUMAN_VERIFICATION_REQUIRED", message: "latest plan waits for the user" },
  };
  await store.saveSession(live);

  const stale = structuredClone(live);
  stale.runtime = {
    status: "waiting_recovery",
    activePlanId: stalePlan.id,
    activeRunId: "stale-run",
    failedTurnId: staleTurn.id,
    error: { code: "HUMAN_VERIFICATION_REQUIRED", message: "stale snapshot" },
  };
  const originalReadSession = store.readSession.bind(store);
  let firstRecoveryRead = true;
  store.readSession = async (sessionId) => {
    if (firstRecoveryRead && sessionId === created.id) {
      firstRecoveryRead = false;
      return structuredClone(stale);
    }
    return originalReadSession(sessionId);
  };

  const calls = [];
  const { baseUrl } = await startServer(t, {
    repoRoot,
    store,
    worker: { async execute(request) { calls.push(request.turnId); return { text: "unexpected" }; } },
  });
  await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  const recovered = await fetch(`${baseUrl}/api/sessions/${created.id}`).then((response) => response.json());

  assert.equal(recovered.session.runtime.activePlanId, latestPlan.id);
  assert.equal(recovered.session.runtime.activeRunId, "latest-run");
  assert.equal(calls.includes(staleTurn.id), false);
});

test("first-message title removes only confirmed provider mention tokens", async (t) => {
  const { baseUrl } = await startServer(t);
  const created = await jsonRequest(`${baseUrl}/api/sessions`, {
    method: "POST",
    body: JSON.stringify({
      participants: ["deepseek"],
      settings: { mode: "mock", defaultRounds: 1 },
      openThreads: false,
    }),
  });
  const text = "@ds 请参考 @team-alpha 的 v1.0 方案";
  const command = await jsonRequest(`${baseUrl}/api/sessions/${created.payload.session.id}/commands`, {
    method: "POST",
    body: JSON.stringify({
      text,
      targets: ["deepseek"],
      mentionTokens: [{ raw: "@ds", providerId: "deepseek", start: 0, end: 3 }],
    }),
  });

  assert.equal(command.response.status, 200);
  assert.equal(command.payload.session.title, "请参考 @team-alpha 的 v1.0 方案");
});

test("server startup restores a persisted recovery run without replaying its interrupted turn", async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-server-interrupted-"));
  const store = new LocalWorkspaceStore({ repoRoot });
  await store.initialize();
  const created = await createStoredSession({
    title: "Interrupted recovery",
    participants: ["doubao", "deepseek"],
    settings: { mode: "playwright", defaultRounds: 1 },
  }, { store });
  const preparationScheduler = new RoundtableScheduler({ store });
  const prepared = await preparationScheduler.prepareCommand(created.id, {
    text: "恢复测试",
    targets: ["doubao", "deepseek"],
    mentionTokens: [
      { id: "doubao", kind: "provider" },
      { id: "deepseek", kind: "provider" },
    ],
    rounds: 1,
  }, { runId: "lost-run" });
  const session = await store.readSession(created.id);
  const plan = session.plans.find((candidate) => candidate.id === prepared.plan.id);
  const turn = plan.turns.find((candidate) => candidate.countsTowardRounds);
  turn.status = "waiting_recovery";
  turn.error = { code: "HUMAN_VERIFICATION_REQUIRED", message: "manual verification required" };
  plan.status = "waiting_recovery";
  session.runtime = {
    status: "waiting_recovery",
    activePlanId: plan.id,
    activeRunId: "lost-run",
    failedTurnId: turn.id,
    error: { code: "HUMAN_VERIFICATION_REQUIRED", message: "manual verification required" },
  };
  await store.saveSession(session);
  store.saveSession = async () => {
    throw new Error("SERVER_RECOVERY_USED_STALE_SESSION_SAVE");
  };

  const calls = [];
  const { baseUrl } = await startServer(t, {
    repoRoot,
    store,
    worker: {
      async execute(request) {
        calls.push(request.turnId);
        return { text: "恢复后的收束回答" };
      },
    },
  });
  await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  const waiting = await waitForSession(baseUrl, session.id, (value) => value.runtime?.status === "waiting_recovery");
  assert.equal(waiting.runtime.activeRunId, "lost-run");
  assert.equal(waiting.runtime.failedTurnId, turn.id);
  assert.equal(calls.includes(turn.id), false);

  const skipped = await jsonRequest(
    `${baseUrl}/api/sessions/${session.id}/runs/lost-run/skip`,
    { method: "POST", body: JSON.stringify({ turnId: turn.id }) },
  );
  assert.equal(skipped.response.status, 200);
  const completed = await waitForSession(baseUrl, session.id, (value) => value.runtime?.status === "idle");
  const completedPlan = completed.plans.find((candidate) => candidate.id === plan.id);
  assert.equal(completedPlan.status, "completed");
  assert.equal(completedPlan.turns.find((candidate) => candidate.id === turn.id).status, "skipped");
  const continuedTurn = completedPlan.turns.find((candidate) => candidate.providerId === "deepseek" && candidate.countsTowardRounds);
  assert.deepEqual(calls, [continuedTurn.id, completedPlan.closureTurnId]);
});

test("compression API is session-scoped and reports missing active state explicitly", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await createSession(baseUrl, { mode: "mock", defaultRounds: 1 });
  const compressionUrl = `${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/context/compression`;

  const read = await jsonRequest(compressionUrl);
  assert.equal(read.response.status, 404);
  assert.equal(read.payload.error, "COMPRESSION_NOT_FOUND");

  const revise = await jsonRequest(`${compressionUrl}/revise`, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 1 }),
  });
  assert.equal(revise.response.status, 404);
  assert.equal(revise.payload.error, "COMPRESSION_NOT_FOUND");
});

test("compression revision API preserves the ledger and records an audit event", async (t) => {
  const { baseUrl, server } = await startServer(t);
  const session = await createSession(baseUrl, { mode: "mock", defaultRounds: 1 });
  const store = server.runtime.store;
  await store.appendEvents(session.id, [
    { id: "compression-source-1", type: "reply", providerId: "deepseek", content: "共识：账本只追加" },
    { id: "compression-source-2", type: "reply", providerId: "deepseek", content: "普通观点" },
  ]);
  await store.updateSession(session.id, (current) => {
    compressSessionContext(current, {
      prompt: "x".repeat(110000),
      estimatePromptTokens: () => 110000,
      estimateEventTokens: () => 10000,
      buildPrompt: () => "x".repeat(15000),
      idFactory: () => "compression-api-1",
      now: () => "2026-07-18T09:00:00.000Z",
    });
    return current;
  });
  const compressionUrl = `${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/context/compression`;
  const ledgerPath = store.getSessionPaths(session.id).ledger;
  const ledgerBefore = await fs.readFile(ledgerPath, "utf8");

  const read = await jsonRequest(compressionUrl);
  assert.equal(read.response.status, 200);
  assert.equal(read.payload.active.revision, 1);

  const revised = await jsonRequest(`${compressionUrl}/revise`, {
    method: "POST",
    body: JSON.stringify({
      baseRevision: 1,
      consensus: [{ id: "consensus-corrected", text: "账本只追加且可审计", sourceEventIds: ["compression-source-1"] }],
    }),
  });
  assert.equal(revised.response.status, 200);
  assert.equal(revised.payload.active.revision, 2);
  assert.equal(revised.payload.active.reason, "user_revision");
  assert.equal((await fs.readFile(ledgerPath, "utf8")), ledgerBefore);
  const audit = await store.listAudit({ sessionId: session.id });
  assert.equal(audit.some((event) => event.kind === "compression_revision" && event.revision === 2), true);
});

test("compression diff, field rollback and annotation APIs review revisions end to end", async (t) => {
  const { baseUrl, server } = await startServer(t);
  const session = await createSession(baseUrl, { mode: "mock", defaultRounds: 1 });
  const store = server.runtime.store;
  await store.appendEvents(session.id, [
    { id: "compression-source-1", type: "reply", providerId: "deepseek", content: "共识：账本只追加" },
    { id: "compression-source-2", type: "reply", providerId: "deepseek", content: "证据：ledger 只追加" },
  ]);
  await store.updateSession(session.id, (current) => {
    compressSessionContext(current, {
      prompt: "x".repeat(110000),
      estimatePromptTokens: () => 110000,
      estimateEventTokens: () => 10000,
      buildPrompt: () => "x".repeat(15000),
      idFactory: () => "compression-api-1",
      now: () => "2026-07-18T09:00:00.000Z",
    });
    return current;
  });
  const compressionUrl = `${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/context/compression`;

  const revised = await jsonRequest(`${compressionUrl}/revise`, {
    method: "POST",
    body: JSON.stringify({
      baseRevision: 1,
      consensus: [{ id: "consensus-corrected", text: "账本只追加且可审计", sourceEventIds: ["compression-source-1"] }],
      evidence: [{ id: "evidence-corrected", text: "ledger 只追加", sourceEventIds: ["compression-source-2"] }],
    }),
  });
  assert.equal(revised.response.status, 200);
  assert.equal(revised.payload.active.revision, 2);

  const diff = await jsonRequest(`${compressionUrl}/diff?from=1&to=2`);
  assert.equal(diff.response.status, 200);
  assert.equal(diff.payload.diff.counts.added, 2);
  assert.equal(diff.payload.diff.counts.removed, 1);
  assert.equal(diff.payload.diff.counts.changed, 0);
  assert.deepEqual(diff.payload.diff.buckets.consensus.added.map((entry) => entry.id), ["consensus-corrected"]);
  assert.deepEqual(diff.payload.diff.buckets.consensus.removed.map((entry) => entry.id), ["consensus:compression-source-1"]);
  assert.deepEqual(diff.payload.diff.buckets.evidence.added.map((entry) => entry.id), ["evidence-corrected"]);
  assert.deepEqual(diff.payload.diff.buckets.evidence.removed, []);

  const rollback = await jsonRequest(`${compressionUrl}/rollback`, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 2, targetRevision: 1, fields: ["consensus"] }),
  });
  assert.equal(rollback.response.status, 200);
  assert.equal(rollback.payload.active.revision, 3);
  assert.equal(rollback.payload.active.reason, "field_rollback");
  assert.deepEqual(rollback.payload.active.rollback, { targetRevision: 1, fields: ["consensus"] });
  assert.equal(rollback.payload.active.consensus[0].text, "账本只追加");
  assert.equal(rollback.payload.active.evidence[0].id, "evidence-corrected");

  const annotate = await jsonRequest(`${compressionUrl}/annotate`, {
    method: "POST",
    body: JSON.stringify({ revision: 3, note: "已核对回滚结果" }),
  });
  assert.equal(annotate.response.status, 200);
  assert.equal(annotate.payload.revision.revision, 3);
  assert.equal(annotate.payload.revision.annotations.length, 1);
  assert.equal(annotate.payload.annotation.note, "已核对回滚结果");

  const read = await jsonRequest(compressionUrl);
  assert.equal(read.response.status, 200);
  assert.equal(read.payload.active.annotations[0].note, "已核对回滚结果");
  assert.equal(read.payload.compression.revisions.length, 3);

  const audit = await store.listAudit({ sessionId: session.id });
  assert.equal(audit.some((event) => event.kind === "compression_rollback" && event.revision === 3), true);
  assert.equal(audit.some((event) => event.kind === "compression_annotation" && event.revision === 3), true);
});

test("compression review APIs reject missing state, unknown revisions and invalid payloads", async (t) => {
  const { baseUrl, server } = await startServer(t);
  const session = await createSession(baseUrl, { mode: "mock", defaultRounds: 1 });
  const store = server.runtime.store;
  const compressionUrl = `${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/context/compression`;

  const diffMissing = await jsonRequest(`${compressionUrl}/diff?from=1&to=2`);
  assert.equal(diffMissing.response.status, 404);
  assert.equal(diffMissing.payload.error, "COMPRESSION_NOT_FOUND");

  await store.appendEvents(session.id, [
    { id: "compression-source-1", type: "reply", providerId: "deepseek", content: "共识：账本只追加" },
    { id: "compression-source-2", type: "reply", providerId: "deepseek", content: "普通观点" },
  ]);
  await store.updateSession(session.id, (current) => {
    compressSessionContext(current, {
      prompt: "x".repeat(110000),
      estimatePromptTokens: () => 110000,
      estimateEventTokens: () => 10000,
      buildPrompt: () => "x".repeat(15000),
      idFactory: () => "compression-api-1",
      now: () => "2026-07-18T09:00:00.000Z",
    });
    return current;
  });

  const diffNoPredecessor = await jsonRequest(compressionUrl + "/diff");
  assert.equal(diffNoPredecessor.response.status, 400);
  assert.equal(diffNoPredecessor.payload.error, "INVALID_COMPRESSION_REVISION");

  const revised = await jsonRequest(`${compressionUrl}/revise`, {
    method: "POST",
    body: JSON.stringify({
      baseRevision: 1,
      consensus: [{ id: "consensus-corrected", text: "账本只追加且可审计", sourceEventIds: ["compression-source-1"] }],
    }),
  });
  assert.equal(revised.response.status, 200);
  assert.equal(revised.payload.active.revision, 2);

  const diffUnknown = await jsonRequest(`${compressionUrl}/diff?from=1&to=9`);
  assert.equal(diffUnknown.response.status, 404);
  assert.equal(diffUnknown.payload.error, "COMPRESSION_REVISION_NOT_FOUND");

  const rollbackStale = await jsonRequest(`${compressionUrl}/rollback`, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 5, targetRevision: 1, fields: ["consensus"] }),
  });
  assert.equal(rollbackStale.response.status, 409);
  assert.equal(rollbackStale.payload.error, "STALE_COMPRESSION_REVISION");

  const rollbackInvalidField = await jsonRequest(`${compressionUrl}/rollback`, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 2, targetRevision: 1, fields: ["nonsense"] }),
  });
  assert.equal(rollbackInvalidField.response.status, 400);
  assert.equal(rollbackInvalidField.payload.error, "INVALID_COMPRESSION_FIELDS");

  const annotateEmpty = await jsonRequest(`${compressionUrl}/annotate`, {
    method: "POST",
    body: JSON.stringify({ revision: 1, note: "   " }),
  });
  assert.equal(annotateEmpty.response.status, 400);
  assert.equal(annotateEmpty.payload.error, "INVALID_COMPRESSION_NOTE");
});

test("session event pagination serves incremental deltas and marks stale cursors for resync", async (t) => {
  const { baseUrl } = await startServer(t, { sqliteControlEnabled: false });
  const session = await createSession(baseUrl, { conversationMode: "discussion", mode: "mock", defaultRounds: 2 }, { openThreads: false });
  const appended = [];
  for (let index = 0; index < 5; index += 1) {
    const { payload } = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "note", content: `增量事件 ${index}` }),
    });
    appended.push(payload.event);
  }

  const full = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/events`);
  assert.equal(full.response.status, 200);
  assert.equal(full.payload.ok, true);
  assert.equal(full.payload.fromIndex, 0);
  assert.equal(full.payload.total, 5);
  assert.equal(full.payload.nextIndex, 5);
  assert.equal(full.payload.resyncRequired, false);
  assert.deepEqual(full.payload.events.map((event) => event.id), appended.map((event) => event.id));

  const delta = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/events?after=2&lastEventId=${encodeURIComponent(appended[1].id)}`);
  assert.equal(delta.response.status, 200);
  assert.equal(delta.payload.resyncRequired, false);
  assert.equal(delta.payload.fromIndex, 2);
  assert.equal(delta.payload.nextIndex, 5);
  assert.deepEqual(delta.payload.events.map((event) => event.id), appended.slice(2).map((event) => event.id));

  const ahead = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/events?after=5`);
  assert.equal(ahead.response.status, 200);
  assert.equal(ahead.payload.resyncRequired, false);
  assert.deepEqual(ahead.payload.events, []);

  const limited = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/events?after=0&limit=2`);
  assert.equal(limited.payload.events.length, 2);
  assert.equal(limited.payload.nextIndex, 2);

  const stale = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/events?after=2&lastEventId=${encodeURIComponent(appended[4].id)}`);
  assert.equal(stale.payload.resyncRequired, true);
  assert.equal(stale.payload.fromIndex, 0);
  assert.equal(stale.payload.events.length, 5);

  const beyond = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/events?after=999`);
  assert.equal(beyond.payload.resyncRequired, true);

  const invalidCursor = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/events?after=abc`);
  assert.equal(invalidCursor.response.status, 400);

  const invalidLimit = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/events?after=0&limit=0`);
  assert.equal(invalidLimit.response.status, 400);

  const omitted = await jsonRequest(`${baseUrl}/api/sessions/${session.id}?events=none`);
  assert.equal(omitted.response.status, 200);
  assert.equal(omitted.payload.ok, true);
  assert.equal(omitted.payload.eventsOmitted, true);
  assert.equal(omitted.payload.totalEvents, 5);
  assert.deepEqual(omitted.payload.session.events, []);
  const intactMeta = omitted.payload.session;
  assert.equal(intactMeta.id, session.id);
  assert.ok(Array.isArray(intactMeta.participants));
});

test("chunked command transfers upload long commands with resume and dispatch them", async (t) => {
  const { baseUrl } = await startServer(t, {
    sqliteControlEnabled: false,
    commandTransfers: new CommandTransferRegistry({ chunkBytes: 4096 }),
  });
  const session = await createSession(baseUrl, { conversationMode: "discussion", mode: "mock", defaultRounds: 2 }, { openThreads: false });
  const text = "这是超长指令：\n" + "圆桌请就大文件链路的分块传输与断点恢复展开讨论。".repeat(2000);
  const bytes = Buffer.byteLength(text, "utf8");
  const expectedSha256 = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  const command = { targets: ["chatgpt", "deepseek"], mentionTokens: [], rounds: 2, conversationMode: "discussion" };

  const tooBig = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers`, {
    method: "POST",
    body: JSON.stringify({ expectedBytes: 33 * 1024 * 1024, expectedSha256, command: {} }),
  });
  assert.equal(tooBig.response.status, 400);

  const begin = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers`, {
    method: "POST",
    body: JSON.stringify({ expectedBytes: bytes, expectedSha256, command }),
  });
  assert.equal(begin.response.status, 201);
  assert.equal(begin.payload.ok, true);
  assert.equal(begin.payload.chunkBytes, 4096);

  const unknown = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/00000000-0000-0000-0000-000000000000`);
  assert.equal(unknown.response.status, 404);

  const chunkChars = Math.floor((begin.payload.chunkBytes || 4096) / 4);
  const chunks = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + chunkChars, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  assert.ok(chunks.length > 10);

  const outOfOrder = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${begin.payload.transferId}/chunks`, {
    method: "POST",
    body: JSON.stringify({ chunkIndex: 3, content: chunks[3] }),
  });
  assert.equal(outOfOrder.response.status, 409);

  await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${begin.payload.transferId}/chunks`, {
    method: "POST",
    body: JSON.stringify({ chunkIndex: 0, content: chunks[0] }),
  });
  await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${begin.payload.transferId}/chunks`, {
    method: "POST",
    body: JSON.stringify({ chunkIndex: 1, content: chunks[1] }),
  });
  const status = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${begin.payload.transferId}`);
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.receivedChunks, 2);
  assert.equal(status.payload.complete, false);

  for (let index = 2; index < chunks.length; index += 1) {
    await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${begin.payload.transferId}/chunks`, {
      method: "POST",
      body: JSON.stringify({ chunkIndex: index, content: chunks[index] }),
    });
  }

  const commit = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${begin.payload.transferId}/commit`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(commit.response.status, 200);
  assert.equal(commit.payload.ok, true);
  assert.equal(commit.payload.run, null);

  const reloaded = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}`, { headers: { Connection: "close" } }).then((response) => response.json());
  const commandEvent = reloaded.session.events.find((event) => event.type === "command");
  assert.ok(commandEvent);
  assert.equal(commandEvent.content, text);

  const gone = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${begin.payload.transferId}`);
  assert.equal(gone.response.status, 404);

  const badBegin = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers`, {
    method: "POST",
    body: JSON.stringify({ expectedBytes: bytes, expectedSha256: "0".repeat(64), command: {} }),
  });
  assert.equal(badBegin.response.status, 201);
  for (let index = 0; index < chunks.length; index += 1) {
    await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${badBegin.payload.transferId}/chunks`, {
      method: "POST",
      body: JSON.stringify({ chunkIndex: index, content: chunks[index] }),
    });
  }
  const badCommit = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${badBegin.payload.transferId}/commit`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(badCommit.response.status, 400);
  assert.equal(badCommit.payload.code, "COMMAND_TRANSFER_HASH_MISMATCH");

  const cancel = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${badBegin.payload.transferId}`, { method: "DELETE" });
  assert.equal(cancel.response.status, 200);
  assert.equal(cancel.payload.cancelled, true);
  const cancelAgain = await jsonRequest(`${baseUrl}/api/sessions/${session.id}/command-transfers/${badBegin.payload.transferId}`, { method: "DELETE" });
  assert.equal(cancelAgain.response.status, 200);
  assert.equal(cancelAgain.payload.cancelled, false);
});
