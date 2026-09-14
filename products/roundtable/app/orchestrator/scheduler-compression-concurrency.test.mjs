import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PROVIDERS, coerceSettings, createDefaultLayout } from "../core/providers.mjs";
import { LocalWorkspaceStore } from "../storage/local-workspace-store.mjs";
import { RoundtableScheduler } from "./scheduler.mjs";

const COMPRESSION_SECTION = "较早讨论中已经出现的主要判断包括";

function estimatePromptTokens(prompt) {
  return String(prompt).includes(COMPRESSION_SECTION) ? 5000 : 200000;
}

async function createFixture({ providerContextWindowTokens = {} } = {}) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-compression-concurrency-"));
  const store = new LocalWorkspaceStore({ repoRoot, dataRoot: path.join(repoRoot, "data") });
  await store.initialize();
  const participants = ["chatgpt", "deepseek", "doubao"].map((id) => ({
    ...PROVIDERS.find((provider) => provider.id === id),
    status: "ready",
  }));
  const now = new Date().toISOString();
  const session = await store.createSession({
    id: "20260718-100000-concurrent-compression",
    title: "并发压缩测试",
    objective: "验证同周期多席位共享压缩状态",
    createdAt: now,
    updatedAt: now,
    participants,
    hostId: "chatgpt",
    layout: createDefaultLayout(participants),
    settings: coerceSettings({
      mode: "playwright",
      conversationMode: "discussion",
      defaultRounds: 1,
      contextWindowTokens: 131072,
      compressionTriggerPercent: 80,
      compressionTargetPercent: 20,
      recentRawTokenBudget: 1024,
      providerContextWindowTokens,
    }),
    plans: [],
    summary: null,
    runtime: {},
    threads: Object.fromEntries(participants.map((participant) => [participant.id, {
      id: `thread-${participant.id}`,
      threadKey: `seat:${participant.id}`,
      status: "ready",
      lastDeliveredEventIndex: -1,
      usage: { sentChars: 0, capturedChars: 0, interactions: 0 },
    }])),
    context: {
      seatCursors: Object.fromEntries(participants.map((participant) => [participant.id, -1])),
      summaries: [],
    },
    events: [
      { id: "old-1", type: "reply", providerId: "chatgpt", content: "共识：保留账本" },
      { id: "old-2", type: "reply", providerId: "deepseek", content: "分歧：是否自动总结" },
      { id: "old-3", type: "reply", providerId: "doubao", content: "证据：哈希稳定" },
      { id: "old-4", type: "reply", providerId: "chatgpt", content: "决定：先跑本地规则" },
    ],
  });
  return { store, session };
}

function compressionOverrides() {
  return {
    estimatePromptTokens,
    estimateEventTokens: () => 800,
  };
}

function createRecordingScheduler(store, { delayMs = 0 } = {}) {
  const calls = [];
  const order = [];
  const worker = {
    async execute(request) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(request.providerId);
      calls.push({ ...request });
      return { text: `${request.providerId}-R${request.round}-reply` };
    },
  };
  const scheduler = new RoundtableScheduler({
    store,
    worker,
    contextCompression: compressionOverrides(),
  });
  return { scheduler, calls, order };
}

test("concurrent seats in one cycle share a single compression revision from the first triggering seat", async () => {
  const { store, session } = await createFixture();
  const { scheduler, calls } = createRecordingScheduler(store);

  const result = await scheduler.executeCommand(session.id, { text: "@全体 讨论压缩" });

  assert.equal(result.plan.status, "completed");
  const saved = await store.readSession(session.id);
  assert.equal(saved.context.compression.revisions.length, 1);
  assert.equal(saved.context.compression.active.revision, 1);
  assert.equal(saved.context.compression.active.reason, "automatic");
  assert.equal(saved.context.compression.active.providerId, "chatgpt");
  assert.equal(saved.context.compression.active.metrics.entryCount, 3);
  assert.equal(saved.context.compression.active.metrics.classifiedEntryCount, 3);
  assert.equal(saved.context.compression.active.metrics.disagreementEntryCount, 1);
  assert.equal(saved.context.compression.active.metrics.droppedUnclassifiedEntryCount, 0);

  const roundOne = calls.filter((call) => call.round === 1 && call.role !== "closure");
  assert.equal(roundOne.length, 3);
  for (const call of roundOne) {
    assert.match(call.prompt, new RegExp(COMPRESSION_SECTION));
    assert.match(call.prompt, /仍未解决的分歧包括/);
    assert.ok(call.prompt.includes("先跑本地规则"), "recent raw event stays in every seat prompt");
    assert.doesNotMatch(call.prompt, /<compressed_roundtable_context>|revision|sourceEventIds/);
  }
  const closure = calls.find((call) => call.role === "closure");
  assert.ok(closure);
  assert.match(closure.prompt, new RegExp(COMPRESSION_SECTION));
});

test("per-seat window overrides let only small-window seats trigger compression in a shared cycle", async () => {
  const { store, session } = await createFixture({
    providerContextWindowTokens: { chatgpt: 1000000 },
  });
  const { scheduler, calls } = createRecordingScheduler(store);

  const result = await scheduler.executeCommand(session.id, { text: "@全体 讨论压缩" });

  assert.equal(result.plan.status, "completed");
  const saved = await store.readSession(session.id);
  assert.equal(saved.context.compression.revisions.length, 1);
  assert.equal(saved.context.compression.active.providerId, "deepseek");
  assert.equal(saved.context.compression.active.metrics.entryCount, 3);

  const roundOne = calls.filter((call) => call.round === 1 && call.role !== "closure");
  const chatgptCall = roundOne.find((call) => call.providerId === "chatgpt");
  const deepseekCall = roundOne.find((call) => call.providerId === "deepseek");
  const doubaoCall = roundOne.find((call) => call.providerId === "doubao");
  assert.doesNotMatch(chatgptCall.prompt, new RegExp(COMPRESSION_SECTION));
  assert.match(deepseekCall.prompt, new RegExp(COMPRESSION_SECTION));
  assert.match(doubaoCall.prompt, new RegExp(COMPRESSION_SECTION));
});

test("interleaved concurrent turns keep compression state and persisted prompts consistent", async () => {
  // defaultRounds 的最小值是 2：两个讨论周期 3+3 个回合加收束共 7 次执行。
  const { store, session } = await createFixture();
  const { scheduler, calls, order } = createRecordingScheduler(store, { delayMs: 5 });

  const result = await scheduler.executeCommand(session.id, { text: "@全体 讨论压缩" });

  assert.equal(result.plan.status, "completed");
  assert.equal(order.length, 7);
  assert.equal(result.plan.rounds, 2);

  const saved = await store.readSession(session.id);
  assert.equal(saved.context.compression.revisions.length, 1);
  assert.equal(saved.context.compression.active.providerId, "chatgpt");

  const savedPlan = saved.plans.find((plan) => plan.id === result.plan.id);
  const roundOneTurns = savedPlan.turns.filter((turn) => turn.round === 1);
  const roundOneCalls = calls.filter((call) => call.round === 1 && call.role !== "closure");
  assert.equal(roundOneTurns.length, 3);
  for (const call of roundOneCalls) {
    const turn = roundOneTurns.find((candidate) => candidate.providerId === call.providerId);
    assert.ok(turn, `persisted turn for ${call.providerId}`);
    assert.equal(turn.prompt, call.prompt);
    assert.equal(turn.status, "completed");
  }

  const savedReplies = saved.events.filter((event) => event.type === "reply" && event.round === 1);
  assert.equal(savedReplies.length, 3);
  assert.deepEqual(
    savedReplies.map((event) => event.providerId).sort(),
    ["chatgpt", "deepseek", "doubao"],
  );
});
