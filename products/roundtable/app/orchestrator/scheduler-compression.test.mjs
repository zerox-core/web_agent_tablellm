import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalWorkspaceStore } from "../storage/local-workspace-store.mjs";
import { RoundtableScheduler } from "./scheduler.mjs";

async function createFixture() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-compression-scheduler-"));
  const store = new LocalWorkspaceStore({ repoRoot, dataRoot: path.join(repoRoot, "data") });
  await store.initialize();
  const now = new Date().toISOString();
  const session = await store.createSession({
    id: "20260718-090000-compress1",
    title: "压缩调度测试",
    objective: "验证自动压缩进入发送前链路",
    createdAt: now,
    updatedAt: now,
    participants: [{ id: "deepseek", label: "DeepSeek", status: "ready" }],
    hostId: "deepseek",
    layout: {},
    settings: {
      mode: "playwright",
      defaultRounds: 1,
      conversationMode: "discussion",
      contextWindowTokens: 131072,
      compressionTriggerPercent: 80,
      compressionTargetPercent: 20,
      recentRawTokenBudget: 1024,
    },
    plans: [],
    summary: null,
    runtime: {},
    threads: {
      deepseek: {
        id: "thread-deepseek",
        threadKey: "seat:deepseek",
        status: "ready",
        lastDeliveredEventIndex: -1,
        usage: { sentChars: 0, capturedChars: 0, interactions: 0 },
      },
    },
    context: { seatCursors: { deepseek: -1 }, summaries: [] },
    events: [
      { id: "old-1", type: "reply", providerId: "deepseek", content: "共识：保留账本" },
      { id: "old-2", type: "reply", providerId: "deepseek", content: "分歧：是否自动总结" },
      { id: "old-3", type: "reply", providerId: "deepseek", content: "证据：哈希稳定" },
      { id: "old-4", type: "reply", providerId: "deepseek", content: "决定：先跑本地规则" },
    ],
  });
  return { store, session };
}

test("scheduler persists one automatic compression before sending a turn", async () => {
  const { store, session } = await createFixture();
  let estimateCalls = 0;
  const calls = [];
  const scheduler = new RoundtableScheduler({
    store,
    worker: {
      async execute(request) {
        calls.push(request);
        return { text: "发送完成" };
      },
    },
    contextCompression: {
      estimatePromptTokens() {
        estimateCalls += 1;
        return estimateCalls === 1 ? 110000 : 15000;
      },
      estimateEventTokens: () => 1000,
    },
  });

  await scheduler.executeCommand(session.id, { text: "@ds 继续" });

  const saved = await store.readSession(session.id);
  assert.equal(saved.context.compression.active.revision, 1);
  assert.equal(saved.context.compression.active.reason, "automatic");
  assert.equal(saved.context.compression.active.providerId, "deepseek");
  assert.equal(saved.context.compression.active.metrics.entryCount, 3);
  assert.equal(saved.context.compression.active.metrics.classifiedEntryCount, 3);
  assert.equal(saved.context.compression.active.metrics.droppedUnclassifiedEntryCount, 0);
  assert.equal(saved.context.compression.revisions.length, 1);
  assert.match(calls[0].prompt, /较早讨论中已经出现的主要判断包括/);
  assert.match(calls[0].prompt, /仍未解决的分歧包括/);
  assert.doesNotMatch(calls[0].prompt, /<compressed_roundtable_context>|revision|sourceEventIds/);
  assert.ok(estimateCalls >= 2);
});

test("compression failure keeps the raw prompt path and persists a diagnostic", async () => {
  const { store, session } = await createFixture();
  const calls = [];
  const scheduler = new RoundtableScheduler({
    store,
    worker: {
      async execute(request) {
        calls.push(request);
        return { text: "仍可发送" };
      },
    },
    contextCompression: {
      compress() {
        throw Object.assign(new Error("压缩器不可用"), { code: "COMPRESSION_ENGINE_DOWN" });
      },
    },
  });

  await scheduler.executeCommand(session.id, { text: "@ds 继续" });

  const saved = await store.readSession(session.id);
  assert.equal(saved.context.compression.active, null);
  assert.equal(saved.context.compression.lastError.code, "COMPRESSION_ENGINE_DOWN");
  assert.doesNotMatch(calls[0].prompt, /<compressed_roundtable_context>/);
});
