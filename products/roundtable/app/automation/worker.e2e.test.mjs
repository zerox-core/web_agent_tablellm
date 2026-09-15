import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserManager } from "./browser-manager.mjs";
import { createProviderAdapters } from "./adapters/index.mjs";
import { BrowserWorker } from "./worker.mjs";
import { startFakeProviderServer } from "../test-support/fake-provider-server.mjs";

async function createFixture(t, overrides = () => ({})) {
  const fake = await startFakeProviderServer();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-browser-worker-"));
  const urlOverrides = {
    chatgpt: `${fake.baseUrl}/chatgpt`,
    deepseek: `${fake.baseUrl}/deepseek`,
    doubao: `${fake.baseUrl}/doubao`,
    ...overrides(fake.baseUrl),
  };
  const adapters = createProviderAdapters({ urlOverrides });
  const manager = new BrowserManager({
    profileDir: path.join(root, "profile"),
    adapters,
    headless: true,
    channel: "chrome",
  });
  const worker = new BrowserWorker({ manager, adapters });
  t.after(async () => {
    await manager.close();
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { fake, root, manager, worker };
}

test("browser worker inserts, submits, waits for streaming completion, and captures all MVP providers", { timeout: 60000 }, async (t) => {
  const { root, worker } = await createFixture(t);
  const diagnosticsDir = path.join(root, "diagnostics");
  const providerIds = ["chatgpt", "deepseek", "doubao"];
  const results = [];
  for (const providerId of providerIds) {
    results.push(await worker.execute({
      sessionId: "fake-session",
      planId: "fake-plan",
      turnId: `turn-${providerId}`,
      providerId,
      prompt: `来自 ${providerId} 的完整自动化测试`,
      round: 1,
      timeoutMs: 10000,
      settleMs: 120,
      autoSend: true,
      autoCapture: true,
      diagnosticsDir,
    }));
  }

  assert.deepEqual(results.map((result) => result.providerId), providerIds);
  for (let index = 0; index < providerIds.length; index += 1) {
    assert.match(results[index].text, new RegExp(`FAKE_RESPONSE\\[${providerIds[index]}\\]#1`));
    assert.match(results[index].text, /完整自动化测试/);
    assert.ok(results[index].capture.selector);
  }
});

test("browser worker ignores baseline replies on a reused provider page", { timeout: 30000 }, async (t) => {
  const { root, worker } = await createFixture(t);
  const common = {
    sessionId: "fake-session",
    planId: "fake-plan",
    providerId: "chatgpt",
    round: 1,
    timeoutMs: 10000,
    settleMs: 120,
    autoSend: true,
    autoCapture: true,
    diagnosticsDir: path.join(root, "diagnostics"),
  };
  const first = await worker.execute({ ...common, turnId: "turn-one", prompt: "first prompt" });
  const second = await worker.execute({ ...common, turnId: "turn-two", prompt: "second prompt" });
  assert.match(first.text, /#1: first prompt/);
  assert.match(second.text, /#2: second prompt/);
  assert.doesNotMatch(second.text, /first prompt/);
});

test("browser worker distinguishes Doubao replies that reuse the same data-testid", { timeout: 30000 }, async (t) => {
  const { root, worker } = await createFixture(t);
  const common = {
    sessionId: "fake-session",
    planId: "fake-plan",
    providerId: "doubao",
    round: 1,
    timeoutMs: 10000,
    settleMs: 120,
    autoSend: true,
    autoCapture: true,
    diagnosticsDir: path.join(root, "diagnostics"),
  };
  const first = await worker.execute({ ...common, turnId: "doubao-one", prompt: "same test id first" });
  const second = await worker.execute({ ...common, turnId: "doubao-two", prompt: "same test id second" });
  assert.match(first.text, /#1: same test id first/);
  assert.match(second.text, /#2: same test id second/);
});

test("browser worker reacquires a composer that is replaced before submission", { timeout: 30000 }, async (t) => {
  const { root, worker } = await createFixture(t, (baseUrl) => ({ chatgpt: `${baseUrl}/chatgpt?churn=1` }));
  const result = await worker.execute({
    sessionId: "fake-session",
    planId: "fake-plan",
    turnId: "churn-turn",
    providerId: "chatgpt",
    prompt: "composer replacement test",
    round: 1,
    timeoutMs: 10000,
    settleMs: 120,
    autoSend: true,
    autoCapture: true,
    diagnosticsDir: path.join(root, "diagnostics"),
  });
  assert.match(result.text, /composer replacement test/);
});

test("browser worker records screenshot and metadata when no composer is available", { timeout: 30000 }, async (t) => {
  const { root, worker } = await createFixture(t, (baseUrl) => ({ chatgpt: `${baseUrl}/broken` }));
  const diagnosticsDir = path.join(root, "diagnostics");
  await assert.rejects(
    () => worker.execute({
      sessionId: "fake-session",
      planId: "fake-plan",
      turnId: "broken-turn",
      providerId: "chatgpt",
      prompt: "will fail",
      round: 1,
      timeoutMs: 1200,
      settleMs: 100,
      autoSend: true,
      autoCapture: true,
      diagnosticsDir,
    }),
    (error) => error.code === "LOGIN_REQUIRED"
  );

  const entries = await fs.readdir(diagnosticsDir);
  assert.ok(entries.some((name) => name.endsWith(".json")));
  assert.ok(entries.some((name) => name.endsWith(".png")));
  const metadataName = entries.find((name) => name.endsWith(".json"));
  const metadata = JSON.parse(await fs.readFile(path.join(diagnosticsDir, metadataName), "utf8"));
  assert.equal(metadata.providerId, "chatgpt");
  assert.equal(metadata.turnId, "broken-turn");
  assert.match(metadata.url, /\/broken$/);
});

test("browser worker pauses immediately when a provider opens human verification", { timeout: 30000 }, async (t) => {
  const { root, manager, worker } = await createFixture(t, (baseUrl) => ({ doubao: `${baseUrl}/doubao?captcha=1` }));
  const diagnosticsDir = path.join(root, "diagnostics");
  const startedAt = Date.now();
  await assert.rejects(
    () => worker.execute({
      sessionId: "fake-session",
      planId: "fake-plan",
      turnId: "captcha-turn",
      providerId: "doubao",
      prompt: "trigger human verification",
      round: 1,
      timeoutMs: 10000,
      settleMs: 100,
      autoSend: true,
      autoCapture: true,
      diagnosticsDir,
    }),
    (error) => {
      assert.equal(error.code, "HUMAN_VERIFICATION_REQUIRED");
      assert.equal(error.details.phase, "wait_for_response");
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 5000, "human verification should not degrade into a response timeout");
  assert.equal(manager.status().pages.some((page) => page.providerId === "doubao"), false);

  const metadataName = (await fs.readdir(diagnosticsDir)).find((name) => name.endsWith(".json"));
  const metadata = JSON.parse(await fs.readFile(path.join(diagnosticsDir, metadataName), "utf8"));
  assert.equal(metadata.error.code, "HUMAN_VERIFICATION_REQUIRED");
  assert.equal(metadata.providerId, "doubao");
});

test("browser worker classifies a login redirect while waiting for a response", { timeout: 30000 }, async (t) => {
  const { root, manager, worker } = await createFixture(t, (baseUrl) => ({ deepseek: `${baseUrl}/deepseek?login=1` }));
  await assert.rejects(
    () => worker.execute({
      sessionId: "fake-session",
      planId: "fake-plan",
      turnId: "login-redirect-turn",
      providerId: "deepseek",
      prompt: "trigger login redirect",
      round: 1,
      timeoutMs: 10000,
      settleMs: 100,
      autoSend: true,
      autoCapture: true,
      diagnosticsDir: path.join(root, "diagnostics"),
    }),
    (error) => {
      assert.equal(error.code, "LOGIN_REQUIRED");
      assert.match(error.details.url, /\/sign_in$/);
      return true;
    }
  );
  assert.equal(manager.status().pages.some((page) => page.providerId === "deepseek"), false);
});

test("browser worker follows a conversation moved into a popup tab", { timeout: 30000 }, async (t) => {
  const { root, worker } = await createFixture(t, (baseUrl) => ({ chatgpt: `${baseUrl}/chatgpt?popup=1` }));
  const result = await worker.execute({
    sessionId: "fake-session",
    planId: "fake-plan",
    turnId: "popup-turn",
    providerId: "chatgpt",
    prompt: "popup follow test",
    round: 1,
    timeoutMs: 10000,
    settleMs: 120,
    autoSend: true,
    autoCapture: true,
    diagnosticsDir: path.join(root, "diagnostics"),
  });
  assert.match(result.text, /FAKE_RESPONSE\[chatgpt\]#1/);
  assert.match(result.capture.url, /\/popup-view/);
});