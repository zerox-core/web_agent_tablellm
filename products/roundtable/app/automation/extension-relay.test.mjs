import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionRelay } from "./extension-relay.mjs";

const verifiedBridge = Object.freeze({
  available: true,
  extensionVersion: "0.1.0",
  bridgeRevision: "legacy-sidecar-v1",
});

function registerVerified(relay, clientId = "client-12345678") {
  return relay.register(clientId, verifiedBridge);
}

function providerStatus(patch = {}) {
  return {
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
    ...patch,
  };
}

test("extension relay completes an allowlisted command through a registered client", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);

  const completion = relay.dispatch({ type: "tabs:probe-provider", provider: "chatgpt" });
  const command = relay.poll("client-12345678");
  assert.equal(command.request.type, "tabs:probe-provider");
  assert.equal(command.request.provider, "chatgpt");

  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tabs:probe-provider",
    data: providerStatus(),
  });
  assert.deepEqual(await completion, {
    ok: true,
    type: "tabs:probe-provider",
    data: providerStatus(),
  });
  assert.equal(relay.status().pendingCommands, 0);
});

test("extension relay preserves only allowlisted provider runtime diagnostics", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);
  const completion = relay.dispatch({ type: "tabs:probe-provider", provider: "deepseek", tabId: 42 });
  const command = relay.poll("client-12345678");

  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tabs:probe-provider",
    data: providerStatus({
      provider: "deepseek",
      url: "https://chat.deepseek.com/a",
      adapterDiagnostics: {
        bridgeState: "ready",
        adapterSource: "plugin_registry",
        activationState: "succeeded",
        sidecarInjected: true,
        composerFound: true,
        adapterPresent: true,
        hasInsertText: true,
        hasInsertTextIntoInput: false,
        hasSubmitForm: true,
        token: "must-not-cross",
        account: { id: "private" },
      },
    }),
  });

  const result = await completion;
  assert.deepEqual(result.data.adapterDiagnostics, {
    bridgeState: "ready",
    adapterSource: "plugin_registry",
    activationState: "succeeded",
    sidecarInjected: true,
    composerFound: true,
    adapterPresent: true,
    hasInsertText: true,
    hasInsertTextIntoInput: false,
    hasSubmitForm: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-cross|token|account|private/i);
});

test("extension relay refuses unavailable clients and disallowed request types", async (t) => {
  const relay = new ExtensionRelay();
  t.after(() => relay.close());
  relay.register("client-12345678", { available: false });

  await assert.rejects(
    relay.dispatch({ type: "tabs:discover-providers" }),
    (error) => error.code === "EXTENSION_BRIDGE_UNAVAILABLE"
  );
  await assert.rejects(
    relay.dispatch({ type: "mcp:execute-tool-call" }),
    (error) => error.code === "EXTENSION_REQUEST_NOT_ALLOWED"
  );
  await assert.rejects(
    relay.dispatch({ type: "tab:auto-send-text", tabId: 7, text: 42 }),
    (error) => error.code === "INVALID_EXTENSION_REQUEST"
  );
});

test("extension relay times out and removes an undelivered command", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 25 });
  t.after(() => relay.close());
  registerVerified(relay);

  await assert.rejects(
    relay.dispatch({ type: "tab:detect", tabId: 7 }, { timeoutMs: 25 }),
    (error) => error.code === "EXTENSION_COMMAND_TIMEOUT"
  );
  assert.equal(relay.poll("client-12345678"), null);
  assert.equal(relay.status().pendingCommands, 0);
});

test("extension relay removes stale clients and exposes status without command payloads", async (t) => {
  let now = 1000;
  const relay = new ExtensionRelay({ clientTtlMs: 100, now: () => now });
  t.after(() => relay.close());
  registerVerified(relay);

  const initial = relay.status();
  assert.equal(initial.connected, true);
  assert.equal(initial.clients[0].extensionVersion, "0.1.0");
  assert.equal(initial.clients[0].verified, true);
  assert.equal("queue" in initial.clients[0], false);

  now = 1200;
  assert.deepEqual(relay.status(), { connected: false, clients: [], pendingCommands: 0 });
});

test("extension relay carries bounded legacy bridge metadata without secret fields", (t) => {
  const relay = new ExtensionRelay();
  t.after(() => relay.close());

  relay.register("legacy-client-123", {
    available: true,
    extensionVersion: "0.1.0",
    bridgeRevision: "legacy-sidecar-v1",
    token: "must-not-cross",
  });
  relay.heartbeat("legacy-client-123", {
    bridgeRevision: "legacy-sidecar-v1",
    cookie: "must-not-cross",
  });

  const [client] = relay.status().clients;
  assert.equal(client.extensionVersion, "0.1.0");
  assert.equal(client.bridgeRevision, "legacy-sidecar-v1");
  assert.equal(client.verified, true);
  assert.equal(Object.hasOwn(client, "token"), false);
  assert.equal(Object.hasOwn(client, "cookie"), false);
});

test("extension relay rejects an available client with incompatible bridge metadata", (t) => {
  const relay = new ExtensionRelay();
  t.after(() => relay.close());

  assert.throws(
    () => relay.register("client-12345678", {
      available: true,
      extensionVersion: "0.0.9",
      bridgeRevision: "legacy-sidecar-v1",
    }),
    (error) => error.code === "EXTENSION_BRIDGE_INCOMPATIBLE",
  );
  assert.throws(
    () => relay.register("client-abcdefgh", {
      available: true,
      extensionVersion: "0.1.0",
      bridgeRevision: "rewrite-v2",
    }),
    (error) => error.code === "EXTENSION_BRIDGE_INCOMPATIBLE",
  );
  assert.equal(relay.status().connected, false);
});

test("extension relay keeps the verified dispatch client sticky until it becomes stale", async (t) => {
  let now = 1000;
  const relay = new ExtensionRelay({ clientTtlMs: 100, commandTimeoutMs: 1000, now: () => now });
  t.after(() => relay.close());
  registerVerified(relay, "client-primary1");

  const firstCompletion = relay.dispatch({ type: "tabs:discover-providers" });
  const first = relay.poll("client-primary1");
  relay.complete("client-primary1", first.commandId, {
    ok: true,
    type: "tabs:discover-providers",
    data: { tabs: [] },
  });
  await firstCompletion;
  assert.equal(relay.activeClientId, "client-primary1");

  now = 1020;
  registerVerified(relay, "client-secondary2");
  relay.heartbeat("client-secondary2", verifiedBridge);
  const secondCompletion = relay.dispatch({ type: "tabs:discover-providers" });
  assert.equal(relay.poll("client-secondary2"), null);
  const second = relay.poll("client-primary1");
  relay.complete("client-primary1", second.commandId, {
    ok: true,
    type: "tabs:discover-providers",
    data: { tabs: [] },
  });
  await secondCompletion;

  now = 1150;
  relay.heartbeat("client-secondary2", verifiedBridge);
  const thirdCompletion = relay.dispatch({ type: "tabs:discover-providers" });
  const third = relay.poll("client-secondary2");
  assert.ok(third);
  relay.complete("client-secondary2", third.commandId, {
    ok: true,
    type: "tabs:discover-providers",
    data: { tabs: [] },
  });
  await thirdCompletion;
  assert.equal(relay.activeClientId, "client-secondary2");
});

test("extension relay drops pending work and reselects after explicit unavailability", async (t) => {
  let now = 1000;
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000, now: () => now });
  t.after(() => relay.close());
  registerVerified(relay, "client-primary1");
  now += 1;
  registerVerified(relay, "client-secondary2");
  now += 1;
  relay.heartbeat("client-primary1");

  const abandoned = relay.dispatch({ type: "tabs:discover-providers" });
  const rejected = assert.rejects(
    abandoned,
    (error) => error.code === "EXTENSION_BRIDGE_UNAVAILABLE",
  );
  relay.heartbeat("client-primary1", { available: false });
  await rejected;
  assert.equal(relay.poll("client-primary1"), null);

  const replacement = relay.dispatch({ type: "tabs:discover-providers" });
  const command = relay.poll("client-secondary2");
  assert.ok(command);
  relay.complete("client-secondary2", command.commandId, {
    ok: true,
    type: "tabs:discover-providers",
    data: { tabs: [] },
  });
  await replacement;
});

test("extension relay invalidates a selected client whose bridge metadata downgrades", async (t) => {
  let now = 1000;
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000, now: () => now });
  t.after(() => relay.close());
  registerVerified(relay, "client-primary1");
  now += 1;
  registerVerified(relay, "client-secondary2");
  now += 1;
  relay.heartbeat("client-primary1");

  const firstCompletion = relay.dispatch({ type: "tabs:discover-providers" });
  const first = relay.poll("client-primary1");
  relay.complete("client-primary1", first.commandId, {
    ok: true,
    type: "tabs:discover-providers",
    data: { tabs: [] },
  });
  await firstCompletion;

  assert.throws(
    () => relay.heartbeat("client-primary1", { bridgeRevision: "rewrite-v2" }),
    (error) => error.code === "EXTENSION_BRIDGE_INCOMPATIBLE",
  );
  assert.equal(relay.activeClientId, null);
  assert.equal(relay.status().clients.find(({ clientId }) => clientId === "client-primary1").verified, false);

  const replacement = relay.dispatch({ type: "tabs:discover-providers" });
  const command = relay.poll("client-secondary2");
  assert.ok(command);
  relay.complete("client-secondary2", command.commandId, {
    ok: true,
    type: "tabs:discover-providers",
    data: { tabs: [] },
  });
  await replacement;
});

test("extension relay rejects results from a different client", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);
  registerVerified(relay, "client-abcdefgh");
  const completion = relay.dispatch({ type: "tabs:discover-providers" });
  const owner = relay.poll("client-abcdefgh") || relay.poll("client-12345678");
  const ownerClient = relay.pending.get(owner.commandId).clientId;
  const wrongClient = ownerClient === "client-abcdefgh" ? "client-12345678" : "client-abcdefgh";

  assert.throws(
    () => relay.complete(wrongClient, owner.commandId, { ok: true, type: "tabs:discover-providers", data: { tabs: [] } }),
    (error) => error.code === "EXTENSION_COMMAND_NOT_FOUND"
  );
  relay.complete(ownerClient, owner.commandId, {
    ok: true,
    type: "tabs:discover-providers",
    data: { tabs: [] },
  });
  await completion;
});

test("extension relay rejects a result whose type does not match the pending command", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);
  const completion = relay.dispatch({ type: "tab:auth-probe", tabId: 7 });
  const command = relay.poll("client-12345678");

  assert.throws(
    () => relay.complete("client-12345678", command.commandId, {
      ok: true,
      type: "tab:capture-latest",
      data: { provider: "chatgpt", text: "wrong result" },
    }),
    (error) => error.code === "INVALID_EXTENSION_RESULT"
  );
  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tab:auth-probe",
    data: { provider: "chatgpt", authenticated: true, reason: "authenticated" },
  });
  await completion;
});

test("extension relay validates and narrows successful result data", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);
  const completion = relay.dispatch({ type: "tab:auth-probe", tabId: 7 });
  const command = relay.poll("client-12345678");

  assert.throws(
    () => relay.complete("client-12345678", command.commandId, {
      ok: true,
      type: "tab:auth-probe",
      data: { provider: "chatgpt", authenticated: "yes", reason: "authenticated" },
    }),
    (error) => error.code === "INVALID_EXTENSION_RESULT"
  );
  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tab:auth-probe",
    data: {
      provider: "chatgpt",
      authenticated: true,
      reason: "authenticated",
      token: "must-not-cross",
    },
  });
  const result = await completion;
  assert.deepEqual(result, {
    ok: true,
    type: "tab:auth-probe",
    data: { provider: "chatgpt", authenticated: true, reason: "authenticated" },
  });
  assert.equal("token" in result.data, false);
});

test("extension relay accepts only explicit assistant capture results", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);
  const completion = relay.dispatch({ type: "tab:capture-latest", tabId: 7 });
  const command = relay.poll("client-12345678");

  for (const speaker of [undefined, "user", "unknown"]) {
    assert.throws(
      () => relay.complete("client-12345678", command.commandId, {
        ok: true,
        type: "tab:capture-latest",
        data: {
          provider: "deepseek",
          ...(speaker === undefined ? {} : { speaker }),
          text: "must not cross",
          capturedAt: new Date().toISOString(),
        },
      }),
      (error) => error.code === "INVALID_EXTENSION_RESULT",
    );
  }

  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tab:capture-latest",
    data: {
      provider: "deepseek",
      speaker: "assistant",
      text: "assistant answer",
      capturedAt: new Date().toISOString(),
    },
  });
  assert.equal((await completion).data.speaker, "assistant");
});

test("extension relay accepts the production verification-required auto-send result", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);
  const completion = relay.dispatch({ type: "tab:auto-send-text", tabId: 7, text: "Prompt" });
  const command = relay.poll("client-12345678");

  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tab:auto-send-text",
    data: {
      provider: "chatgpt",
      state: "verification_required",
      message: "Manual verification required",
    },
  });
  assert.deepEqual(await completion, {
    ok: true,
    type: "tab:auto-send-text",
    data: {
      provider: "chatgpt",
      state: "verification_required",
      message: "Manual verification required",
    },
  });
});

test("extension relay accepts a reduced human-verification auth reason", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);
  const completion = relay.dispatch({ type: "tab:auth-probe", tabId: 7 });
  const command = relay.poll("client-12345678");

  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tab:auth-probe",
    data: {
      provider: "deepseek",
      authenticated: false,
      reason: "human_verification_required",
      verificationRequired: true,
    },
  });

  assert.deepEqual((await completion).data, {
    provider: "deepseek",
    authenticated: false,
    reason: "human_verification_required",
    verificationRequired: true,
  });
});

test("extension relay preserves a bounded insert failure state and drops secrets", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);
  const completion = relay.dispatch({ type: "tab:insert-text", tabId: 7, text: "Prompt" });
  const command = relay.poll("client-12345678");

  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tab:insert-text",
    data: {
      ok: false,
      provider: "deepseek",
      state: "input_busy",
      message: "User draft is present",
      token: "must-not-cross",
    },
  });

  assert.deepEqual((await completion).data, {
    ok: false,
    provider: "deepseek",
    state: "input_busy",
    message: "User draft is present",
  });
});

test("extension relay accepts the legacy open-provider metadata contract", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);
  const completion = relay.dispatch({ type: "tabs:open-provider", provider: "doubao" });
  const command = relay.poll("client-12345678");

  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tabs:open-provider",
    data: {
      provider: "doubao",
      label: "豆包",
      tabId: 17,
      url: "https://www.doubao.com/chat/",
      status: "ready",
      reused: true,
    },
  });

  assert.equal((await completion).data.label, "豆包");
});

test("extension relay accepts the full mvp provider list for tab discovery", async (t) => {
  const relay = new ExtensionRelay({ commandTimeoutMs: 1000 });
  t.after(() => relay.close());
  registerVerified(relay);

  const providers = ["chatgpt", "deepseek", "doubao", "doubao-cn", "kimi", "glm", "gemini"];
  const completion = relay.dispatch({ type: "tabs:discover-providers", providers });
  const command = relay.poll("client-12345678");
  assert.deepEqual(command.request.providers, providers);

  relay.complete("client-12345678", command.commandId, {
    ok: true,
    type: "tabs:discover-providers",
    data: { tabs: [] },
  });
  assert.deepEqual(await completion, { ok: true, type: "tabs:discover-providers", data: { tabs: [] } });
});
