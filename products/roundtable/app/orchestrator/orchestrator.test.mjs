import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PROVIDERS, coerceSettings, createDefaultLayout } from "../core/providers.mjs";
import { LocalWorkspaceStore } from "../storage/local-workspace-store.mjs";
import { parseRoundtableCommand } from "./command-parser.mjs";
import { buildPrompt, getDiscussionStage } from "./context-builder.mjs";
import { RoundtableScheduler, createTurnPlan, requiresLocalToolProtocol, toolProtocolEnabledFor } from "./scheduler.mjs";
import { RunRegistry } from "./run-registry.mjs";
import { EventBus } from "./event-bus.mjs";

async function createSession(store, settings = {}) {
  const participants = ["chatgpt", "deepseek", "doubao"].map((id) => ({
    ...PROVIDERS.find((provider) => provider.id === id),
    status: "ready",
  }));
  const now = new Date().toISOString();
  return store.createSession({
    id: `20260715-130000-${Math.random().toString(16).slice(2, 10)}`,
    title: "真实调度合同",
    objective: "验证共享上下文",
    createdAt: now,
    updatedAt: now,
    participants,
    hostId: "chatgpt",
    layout: createDefaultLayout(participants),
    settings: coerceSettings(settings),
    events: [],
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
  });
}

async function createStore() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-orchestrator-"));
  const store = new LocalWorkspaceStore({ repoRoot, dataRoot: path.join(repoRoot, "data") });
  await store.initialize();
  return store;
}

test("command parser maps aliases and relay route returns to the host", async () => {
  const store = await createStore();
  const discussion = await createSession(store, { conversationMode: "discussion", defaultRounds: 2 });
  assert.deepEqual(parseRoundtableCommand("@ds 先分析", discussion).targets, ["deepseek"]);
  assert.deepEqual(parseRoundtableCommand("@全体 分别讨论", discussion).targets, ["chatgpt", "deepseek", "doubao"]);

  const relay = { ...discussion, settings: coerceSettings({ conversationMode: "relay" }) };
  const parsed = parseRoundtableCommand("如何训练审美", relay);
  assert.deepEqual(parsed.route, ["deepseek", "doubao", "chatgpt"]);
  assert.equal(parsed.hostId, "chatgpt");
});

test("discussion turns share one immutable snapshot and merge replies into the next round", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", defaultRounds: 2, mode: "playwright" });
  const calls = [];
  const worker = {
    async execute(request) {
      calls.push({ ...request });
      return { text: `${request.providerId}-R${request.round}-reply` };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });
  const result = await scheduler.executeCommand(session.id, { text: "@全体 讨论两轮" });

  assert.equal(result.plan.status, "completed");
  assert.deepEqual(result.plan.turns.map((turn) => turn.status), Array(7).fill("completed"));
  assert.equal(result.plan.turns.every((turn) => Boolean(turn.replyPath)), true);
  const roundOne = calls.filter((call) => call.round === 1);
  const roundTwo = calls.filter((call) => call.round === 2);
  const closure = calls.find((call) => call.role === "closure");
  assert.equal(roundOne.length, 3);
  assert.equal(roundTwo.length, 3);
  assert.ok(closure);
  assert.equal(result.plan.rounds, 2);
  assert.equal(result.plan.turns.at(-1).countsTowardRounds, false);
  assert.equal(roundOne.every((call) => !call.prompt.includes("-R1-reply")), true);
  assert.equal(roundTwo.every((call) => call.prompt.includes("chatgpt-R1-reply")), true);
  assert.equal(roundTwo.every((call) => call.prompt.includes("deepseek-R1-reply")), true);
  assert.equal(roundTwo.every((call) => call.prompt.includes("doubao-R1-reply")), true);
  assert.equal(closure.prompt.includes("chatgpt-R2-reply"), true);
  assert.equal(calls.every((call) => call.threadKey === `seat:${call.providerId}`), true);
  assert.equal(calls.every((call) => call.runId === null), true);
  assert.equal(
    calls.filter((call) => call.role !== "closure").every((call) => call.writeExecutorId !== call.providerId),
    true,
  );
  assert.equal(closure.writeExecutorId, "chatgpt");

  const saved = await store.readSession(session.id);
  assert.deepEqual(
    saved.events.filter((event) => event.type === "reply").map((event) => `${event.round}:${event.providerId}`),
    ["1:chatgpt", "1:deepseek", "1:doubao", "2:chatgpt", "2:deepseek", "2:doubao", "null:chatgpt"]
  );
  assert.equal(saved.threads.deepseek.lastDeliveredEventIndex, 3);
  assert.equal(saved.threads.deepseek.usage.interactions, 2);
  assert.equal(saved.threads.chatgpt.lastDeliveredEventIndex, 6);
  assert.equal(saved.threads.chatgpt.usage.interactions, 3);
});

test("passed seats stay private and can rejoin after a later direct mention", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", defaultRounds: 3, mode: "playwright" });
  const calls = [];
  const worker = {
    async execute(request) {
      calls.push({ ...request });
      if (request.role === "closure") return { text: "东家自然收束" };
      if (request.round === 1) return { text: `${request.providerLabel} 第一周期观点` };
      if (request.round === 2 && request.providerId === "deepseek") return { text: "ChatGPT 的反馈循环观点值得继续讨论。" };
      if (request.round === 2) return { text: "PASS" };
      if (request.round === 3 && request.providerId === "chatgpt") return { text: "我回应 DeepSeek：这里需要加入时间约束。" };
      return { text: "PASS" };
    },
  };
  const eventBus = new EventBus({ historyLimit: 200 });
  const scheduler = new RoundtableScheduler({ store, worker, eventBus });
  const result = await scheduler.executeCommand(session.id, {
    text: "如何进行自学",
    targets: ["chatgpt", "deepseek", "doubao"],
    mentionTokens: [],
    rounds: 3,
  });

  const cycleTwo = result.plan.cycles.find((cycle) => cycle.number === 2);
  const chatgptCycleTwo = result.plan.turns.find((turn) => turn.cycleNumber === 2 && turn.providerId === "chatgpt");
  const chatgptCycleThree = result.plan.turns.find((turn) => turn.cycleNumber === 3 && turn.providerId === "chatgpt");
  assert.equal(chatgptCycleTwo.status, "passed");
  assert.equal(chatgptCycleTwo.replyPath, null);
  assert.equal(chatgptCycleThree.mustRespond, true);
  assert.equal(chatgptCycleThree.status, "completed");
  assert.equal(cycleTwo.passedCount, 2);
  assert.equal(result.session.events.some((event) => /^PASS$/i.test(event.content || "")), false);
  assert.equal(eventBus.history().some((event) => event.type === "turn.passed"), true);
});

test("discussion replies are committed in provider completion order", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", defaultRounds: 2, mode: "playwright" });
  const delays = { chatgpt: 700, deepseek: 5, doubao: 80 };
  const scheduler = new RoundtableScheduler({
    store,
    worker: {
      async execute(request) {
        if (request.role === "closure") return { text: "收束" };
        if (request.round === 2) return { text: "PASS" };
        await new Promise((resolve) => setTimeout(resolve, delays[request.providerId]));
        return { text: `${request.providerId} 完成` };
      },
    },
  });
  const result = await scheduler.executeCommand(session.id, {
    text: "讨论完成顺序",
    targets: ["chatgpt", "deepseek", "doubao"],
    mentionTokens: [],
    rounds: 2,
  });
  assert.deepEqual(
    result.session.events.filter((event) => event.type === "reply" && event.round === 1).map((event) => event.providerId),
    ["deepseek", "doubao", "chatgpt"],
  );
  assert.equal(result.plan.cycles.length, 2);
});

test("a directly addressed seat receives one bounded correction opportunity", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", defaultRounds: 3, mode: "playwright" });
  let doubaoCycleThreeCalls = 0;
  const scheduler = new RoundtableScheduler({
    store,
    worker: {
      async execute(request) {
        if (request.role === "closure") return { text: "收束" };
        if (request.round === 1) return { text: `${request.providerId} 第一周期` };
        if (request.round === 2 && request.providerId === "chatgpt") return { text: "豆包的学习时长判断需要修正。" };
        if (request.round === 2) return { text: "PASS" };
        if (request.round === 3 && request.providerId === "doubao") {
          doubaoCycleThreeCalls += 1;
          return { text: doubaoCycleThreeCalls === 1 ? "PASS" : "我回应 ChatGPT：这里确实需要区分时长和反馈质量。" };
        }
        return { text: "PASS" };
      },
    },
  });

  const result = await scheduler.executeCommand(session.id, {
    text: "如何进行自学",
    targets: ["chatgpt", "deepseek", "doubao"],
    mentionTokens: [],
    rounds: 3,
  });
  const turn = result.plan.turns.find((candidate) => candidate.cycleNumber === 3 && candidate.providerId === "doubao");
  assert.equal(doubaoCycleThreeCalls, 2);
  assert.equal(turn.mustRespond, true);
  assert.equal(turn.participationCorrectionAttempts, 1);
  assert.equal(turn.status, "completed");
  assert.match(result.session.events.find((event) => event.metadata?.turnId === turn.id)?.content || "", /回应 ChatGPT/);
});

test("worker progress becomes a transient turn event and never enters the ledger", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", defaultRounds: 1, mode: "playwright" });
  const eventBus = new EventBus({ historyLimit: 100 });
  const progressAt = "2026-07-20T01:02:03.000Z";
  const worker = {
    async execute(request) {
      await request.onProgress({ text: "## 中间结果\n\n- 正在分析", at: progressAt });
      return { text: "最终结果" };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker, eventBus });

  const result = await scheduler.executeCommand(session.id, {
    text: "只让 DeepSeek 回答",
    targets: ["deepseek"],
    mentionTokens: [],
  });

  const turn = result.plan.turns[0];
  const progress = eventBus.history().find((event) => event.type === "turn.progress");
  assert.deepEqual(progress, {
    id: progress.id,
    type: "turn.progress",
    sessionId: session.id,
    planId: result.plan.id,
    runId: null,
    turnId: turn.id,
    executionId: turn.executionId,
    providerId: "deepseek",
    providerLabel: "DeepSeek",
    round: 1,
    stage: turn.stage,
    text: "## 中间结果\n\n- 正在分析",
    progressTruncated: false,
    progressTotalChars: 15,
    at: progressAt,
  });
  const saved = await store.readSession(session.id);
  assert.equal(saved.events.some((event) => event.type === "turn.progress"), false);
  assert.equal(saved.events.some((event) => event.content.includes("中间结果")), false);
});

test("discussion rounds start all peers concurrently and block the next round", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", defaultRounds: 2, mode: "playwright" });
  const calls = [];
  const releaseByRound = new Map([[1, []], [2, []]]);
  const startedByRound = new Map([[1, 0], [2, 0]]);
  const roundOneStarted = new Promise((resolve) => { releaseByRound.get(1).started = resolve; });
  const roundTwoStarted = new Promise((resolve) => { releaseByRound.get(2).started = resolve; });
  const worker = {
    async execute(request) {
      calls.push({ ...request });
      if (request.role === "closure") return { text: "closure" };
      startedByRound.set(request.round, (startedByRound.get(request.round) || 0) + 1);
      if (startedByRound.get(request.round) === 3) releaseByRound.get(request.round).started();
      await new Promise((resolve) => releaseByRound.get(request.round).push(resolve));
      return { text: `${request.providerId}-R${request.round}` };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });
  const execution = scheduler.executeCommand(session.id, { text: "@全体 受控并发讨论" });

  await roundOneStarted;
  assert.equal(calls.filter((call) => call.round === 1).length, 3);
  assert.equal(calls.filter((call) => call.round === 2).length, 0);
  releaseByRound.get(1).splice(0, 2).forEach((resolve) => resolve());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls.filter((call) => call.round === 2).length, 0);
  releaseByRound.get(1).filter((entry) => typeof entry === "function").forEach((resolve) => resolve());

  await roundTwoStarted;
  const roundTwo = calls.filter((call) => call.round === 2);
  assert.equal(roundTwo.length, 3);
  assert.equal(roundTwo.every((call) => call.prompt.includes("chatgpt-R1")), true);
  assert.equal(roundTwo.every((call) => call.prompt.includes("deepseek-R1")), true);
  assert.equal(roundTwo.every((call) => call.prompt.includes("doubao-R1")), true);
  releaseByRound.get(2).filter((entry) => typeof entry === "function").forEach((resolve) => resolve());
  await execution;
});

test("multi-model host cannot produce a mutating side effect before the visible closure", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", defaultRounds: 1, mode: "playwright" });
  const sideEffectPath = path.join(store.repoRoot, "mutating-side-effects.jsonl");
  const calls = [];
  const worker = {
    async execute(request) {
      calls.push({ ...request });
      if (request.providerId === request.writeExecutorId) {
        await fs.appendFile(sideEffectPath, `${JSON.stringify({ providerId: request.providerId, role: request.role })}\n`, "utf8");
      }
      return { text: `${request.providerId}-${request.role}-reply` };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });

  await scheduler.executeCommand(session.id, { text: "@全体 先讨论再执行" });

  const sideEffects = (await fs.readFile(sideEffectPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.deepEqual(sideEffects, [{ providerId: "chatgpt", role: "closure" }]);
  const firstHostTurn = calls.find((call) => call.round === 1 && call.providerId === "chatgpt");
  const closureTurn = calls.find((call) => call.role === "closure");
  assert.notEqual(firstHostTurn.writeExecutorId, firstHostTurn.providerId);
  assert.equal(closureTurn.writeExecutorId, closureTurn.providerId);
});

test("relay execution is sequential and ChatGPT receives the host summary prompt", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "relay", mode: "playwright" });
  const calls = [];
  const worker = {
    async execute(request) {
      calls.push({ ...request });
      return { text: `${request.providerId}-relay-reply` };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });
  const result = await scheduler.executeCommand(session.id, { text: "如何训练审美", writeExecutorId: "deepseek" });

  assert.deepEqual(calls.map((call) => call.providerId), ["deepseek", "doubao", "chatgpt"]);
  assert.match(calls[1].prompt, /deepseek-relay-reply/);
  assert.match(calls[2].prompt, /doubao-relay-reply/);
  assert.match(calls[2].prompt, /你是东家/);
  assert.match(calls[1].prompt, /原始任务：如何训练审美/);
  assert.match(calls[2].prompt, /最后成功接力棒/);
  assert.equal(result.plan.turns.at(-1).role, "host_summary");
  assert.equal(result.plan.rounds, 1);
  assert.equal(result.plan.turns.at(-1).countsTowardRounds, false);
  assert.equal(calls.slice(0, -1).every((call) => !["chatgpt", "deepseek", "doubao"].includes(call.writeExecutorId)), true);
  assert.equal(calls.at(-1).writeExecutorId, "deepseek");
});

test("discussion stage mapping follows the 1, 2, 3, and 4+ round contract", () => {
  const stages = (rounds) => Array.from({ length: rounds }, (_, index) =>
    getDiscussionStage(index + 1, rounds).id
  );

  assert.deepEqual(stages(1), ["independent_position"]);
  assert.deepEqual(stages(2), ["independent_position", "cross_discussion"]);
  assert.deepEqual(stages(3), ["independent_position", "cross_discussion", "convergence"]);
  assert.deepEqual(stages(5), [
    "independent_position",
    "cross_discussion",
    "cross_discussion",
    "cross_discussion",
    "convergence",
  ]);
});

test("context builder labels shared event speakers and respects context limits", async () => {
  const store = await createStore();
  const session = await createSession(store, { maxContextEvents: 4 });
  session.events = [
    { type: "reply", providerId: "chatgpt", content: "one" },
    { type: "reply", providerId: "deepseek", content: "two" },
    { type: "reply", providerId: "doubao", content: "three" },
    { type: "command", providerId: null, content: "four" },
    { type: "reply", providerId: "deepseek", content: "five" },
  ];
  const prompt = buildPrompt(session, "chatgpt", { commandText: "继续" });
  assert.doesNotMatch(prompt, /ChatGPT: one/);
  assert.match(prompt, /DeepSeek：two/);
  assert.match(prompt, /用户：four/);
});

test("context builder requests natural discussion output without a fixed reply schema", async () => {
  const store = await createStore();
  const session = await createSession(store);
  const prompt = buildPrompt(session, "chatgpt", { commandText: "继续", round: 1, targets: ["chatgpt"] });

  assert.match(prompt, /像正常讨论一样直接回答/);
  assert.match(prompt, /自然语言或 Markdown/);
  assert.match(prompt, /模仿人类语气进行自然、正常的交流/);
  assert.match(prompt, /不要每句话单独分段/);
  assert.match(prompt, /只有真正枚举时才使用列表/);
  assert.doesNotMatch(prompt, /web-agents-roundtable\.reply\.v1/);
  assert.doesNotMatch(prompt, /只输出一个 JSON 对象/);
  assert.doesNotMatch(prompt, /missingEvidence/);
});

test("tool protocol routing distinguishes ordinary discussion from explicit local file work", () => {
  assert.equal(requiresLocalToolProtocol({ originalTask: "软件开发最重要的路径是什么", writeExecutorId: null }), false);
  assert.equal(requiresLocalToolProtocol({ originalTask: "读取 F:\\web_agents\\README.md 并分析", writeExecutorId: null }), true);
  assert.equal(requiresLocalToolProtocol({ originalTask: "修改本地文件并保存", writeExecutorId: "chatgpt" }), true);
});

test("workbench switch gates the tool protocol and defaults to off", async () => {
  assert.equal(coerceSettings({}).workbenchEnabled, false);
  assert.equal(coerceSettings({ workbenchEnabled: true }).workbenchEnabled, true);
  assert.equal(coerceSettings({ workbenchEnabled: false }).workbenchEnabled, false);

  const store = await createStore();
  const offSession = await createSession(store);
  const onSession = await createSession(store, { workbenchEnabled: true });
  assert.equal(offSession.settings.workbenchEnabled, false);
  assert.equal(onSession.settings.workbenchEnabled, true);

  const localWork = { originalTask: "读取 F:\\web_agents\\README.md 并分析", writeExecutorId: null };
  const discussion = { originalTask: "软件开发最重要的路径是什么", writeExecutorId: null };
  assert.equal(toolProtocolEnabledFor(offSession, localWork), false);
  assert.equal(toolProtocolEnabledFor(offSession, { originalTask: "修改本地文件并保存", writeExecutorId: "chatgpt" }), false);
  assert.equal(toolProtocolEnabledFor(onSession, localWork), true);
  assert.equal(toolProtocolEnabledFor(onSession, discussion), false);
});

test("context builder relays authoritative raw content even when derived structure exists", async () => {
  const store = await createStore();
  const session = await createSession(store);
  session.events = [{
    type: "reply",
    providerId: "deepseek",
    content: "这是模型实际说出的原文。",
    metadata: {
      structureStatus: "valid",
      structuredReply: {
        summary: "程序派生摘要",
        claims: ["程序派生主张"],
        evidence: [],
        risks: [],
        disagreements: [],
        actions: [],
        missingEvidence: [],
      },
    },
  }];
  const prompt = buildPrompt(session, "chatgpt", { commandText: "继续" });

  assert.match(prompt, /这是模型实际说出的原文/);
  assert.doesNotMatch(prompt, /程序派生摘要|程序派生主张|结构化回复/);
});

test("context builder separates compressed state from recent raw events", async () => {
  const store = await createStore();
  const session = await createSession(store);
  const compression = {
    id: "compression-7",
    revision: 7,
    coveredFromEventIndex: 0,
    coveredThroughEventIndex: 1,
    consensus: [{ id: "c1", text: "原始记录保留", sourceEventIds: ["event-1"] }],
    disagreements: [{ id: "d1", text: "摘要生成方式", sourceEventIds: ["event-2"] }],
    evidence: [],
    decisions: [],
    unclassified: [],
    estimate: { beforeTokens: 110000, afterTokens: 24000, windowTokens: 131072 },
  };
  const prompt = buildPrompt(session, "chatgpt", {
    commandText: "继续",
    projection: {
      providerId: "chatgpt",
      promptEvents: [{ id: "event-3", type: "reply", providerId: "deepseek", content: "近期原文" }],
      publicState: session.context,
      compression,
      sync: { current: 0, projected: 3, total: 3 },
    },
  });

  assert.match(prompt, /较早讨论中已经出现的主要判断包括：原始记录保留/);
  assert.match(prompt, /仍未解决的分歧包括：摘要生成方式/);
  assert.match(prompt, /DeepSeek：近期原文/);
  assert.doesNotMatch(prompt, /压缩修订|覆盖事件|event-1|event-2|compressed_roundtable_context|shared_roundtable_context/);
  assert.doesNotMatch(prompt, /被覆盖的旧原文/);
});

test("turn plan preserves same-round target order", async () => {
  const store = await createStore();
  const session = await createSession(store, { defaultRounds: 2 });
  const plan = createTurnPlan(session, "@doubao 你和 @gpt 讨论两轮", session.settings);
  assert.deepEqual(plan.turns.map((turn) => `${turn.round}:${turn.providerId}`), [
    "1:doubao",
    "1:chatgpt",
  ]);
  assert.equal(plan.maxCycles, 2);
  assert.deepEqual(plan.cycles[0].turnIds, plan.turns.map((turn) => turn.id));
});

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("WAIT_TIMEOUT");
}

test("technical provider failure is retried once automatically", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", mode: "playwright" });
  let calls = 0;
  const requests = [];
  const worker = {
    async execute(request) {
      calls += 1;
      requests.push({ ...request });
      if (calls === 1) throw Object.assign(new Error("temporary selector failure"), { code: "COMPOSER_NOT_FOUND" });
      return { text: `${request.providerId}-retry-success` };
    },
  };
  const eventBus = new EventBus({ historyLimit: 100 });
  const scheduler = new RoundtableScheduler({ store, worker, eventBus });
  const prepared = await scheduler.prepareCommand(session.id, { text: "@ds 单独分析" });
  assert.equal(calls, 0);
  assert.equal(prepared.plan.status, "running");
  const result = await scheduler.executePreparedPlan(session.id, prepared.plan.id);

  assert.equal(result.plan.status, "completed");
  assert.equal(result.plan.turns[0].attempts, 2);
  assert.equal(result.session.events.at(-1).content, "deepseek-retry-success");
  assert.equal(requests.every((request) => request.runId === null), true);
  assert.equal(requests.every((request) => request.writeExecutorId === "deepseek"), true);
  assert.deepEqual(eventBus.history().filter((event) => event.type === "turn.started").map((event) => event.turn.executionId).length, 2);
});

test("single-model direct execution retains that model's write authority", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", mode: "playwright" });
  const calls = [];
  const scheduler = new RoundtableScheduler({
    store,
    worker: {
      async execute(request) {
        calls.push({ ...request });
        return { text: "deepseek-direct-execution" };
      },
    },
  });

  const result = await scheduler.executeCommand(session.id, { text: "@ds 执行任务" });

  assert.equal(result.plan.mode, "direct");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerId, "deepseek");
  assert.equal(calls[0].writeExecutorId, "deepseek");
});

test("only closure carries the run's snapped multi-model write executor", async () => {
  const store = await createStore();
  const session = await createSession(store, { mode: "playwright", defaultRounds: 1 });
  const calls = [];
  const scheduler = new RoundtableScheduler({
    store,
    worker: {
      async execute(request) {
        calls.push({ ...request });
        return { text: `${request.providerId}-permission-reply` };
      },
    },
  });
  const prepared = await scheduler.prepareCommand(session.id, {
    text: "比较权限方案",
    targets: ["chatgpt", "deepseek"],
    mentionTokens: [],
    rounds: 1,
    writeExecutorId: "doubao",
  }, { runId: "permission-run" });
  await scheduler.executePreparedPlan(session.id, prepared.plan.id, { runId: "permission-run" });

  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.runId === "permission-run"), true);
  assert.equal(calls.slice(0, -1).every((call) => !["chatgpt", "deepseek", "doubao"].includes(call.writeExecutorId)), true);
  assert.equal(calls.at(-1).role, "closure");
  assert.equal(calls.at(-1).writeExecutorId, "doubao");
});

test("worker checkpoints upsert by execution id and complete only after reply persistence", async () => {
  const store = await createStore();
  const session = await createSession(store, { mode: "playwright" });
  let observedExecutionId = null;
  const scheduler = new RoundtableScheduler({
    store,
    worker: {
      async execute(request) {
        observedExecutionId = request.executionId;
        assert.equal(typeof request.checkpoint, "function");
        const prepared = await store.readSession(request.sessionId);
        const persistedTurn = prepared.plans.at(-1).turns[0];
        assert.equal(persistedTurn.executionId, request.executionId);
        assert.equal(
          prepared.checkpoints.find((checkpoint) => checkpoint.executionId === request.executionId)?.phase,
          "prepared",
        );
        await request.checkpoint("submitted", { submissionId: "submission-1" });
        await request.checkpoint("captured", { captureId: "capture-1" });
        return { text: "checkpointed reply" };
      },
    },
  });

  const result = await scheduler.executeCommand(session.id, {
    text: "检查 checkpoint",
    targets: ["deepseek"],
    mentionTokens: [],
  });
  const checkpoint = result.session.checkpoints.find((candidate) => candidate.executionId === observedExecutionId);
  assert.equal(checkpoint.phase, "completed");
  assert.equal(checkpoint.submittedAt !== undefined, true);
  assert.equal(checkpoint.capturedAt !== undefined, true);
  assert.equal(checkpoint.completedAt !== undefined, true);
  assert.deepEqual(
    checkpoint.history.map((entry) => entry.phase),
    ["prepared", "submitted", "captured", "completed"],
  );
  assert.equal(result.plan.turns[0].executionPhase, "completed");
});

test("a restarted ambiguous or completed submission is never dispatched again automatically", async () => {
  for (const phase of ["submitting", "submitted", "captured"]) {
    const store = await createStore();
    const session = await createSession(store, { mode: "playwright" });
    let calls = 0;
    const scheduler = new RoundtableScheduler({
      store,
      worker: { async execute() { calls += 1; return { text: "must not run" }; } },
    });
    const prepared = await scheduler.prepareCommand(session.id, {
      text: "禁止重复发送",
      targets: ["deepseek"],
      mentionTokens: [],
    });
    const persisted = await store.readSession(session.id);
    const turn = persisted.plans.at(-1).turns[0];
    turn.status = "running";
    turn.executionId = `${turn.id}:deepseek:1`;
    turn.executionPhase = phase;
    persisted.checkpoints = [{
      executionId: turn.executionId,
      planId: prepared.plan.id,
      turnId: turn.id,
      providerId: "deepseek",
      phase,
      [`${phase}At`]: new Date().toISOString(),
      history: [],
    }];
    await store.saveSession(persisted);

    await assert.rejects(
      scheduler.executePreparedPlan(session.id, prepared.plan.id),
      (error) => error.code === "EXECUTION_REPLAY_BLOCKED",
      phase,
    );
    assert.equal(calls, 0, phase);
  }
});

test("restart recovery skips a submitted discussion turn and resumes the remaining cycle", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", defaultRounds: 2, mode: "playwright" });
  const calls = [];
  const registry = new RunRegistry();
  const scheduler = new RoundtableScheduler({
    store,
    runRegistry: registry,
    worker: {
      async execute(request) {
        calls.push({ providerId: request.providerId, round: request.round, role: request.role });
        if (request.role === "closure") return { text: "东家收束" };
        if (request.round === 2) return { text: "PASS" };
        return { text: `${request.providerId} 恢复后发言` };
      },
    },
  });
  const prepared = await scheduler.prepareCommand(session.id, {
    text: "验证动态讨论恢复",
    targets: ["chatgpt", "deepseek"],
    mentionTokens: [],
    rounds: 2,
  }, { runId: "restart-discussion-run" });
  const persisted = await store.readSession(session.id);
  const submittedTurn = persisted.plans.at(-1).turns.find((turn) => turn.providerId === "chatgpt");
  submittedTurn.status = "running";
  submittedTurn.executionId = `${submittedTurn.id}:chatgpt:1`;
  submittedTurn.executionPhase = "submitted";
  submittedTurn.sendState = "SENT";
  await store.saveSession(persisted);

  registry.create({
    runId: "restart-discussion-run",
    sessionId: session.id,
    planId: prepared.plan.id,
  });
  const execution = scheduler.executePreparedPlan(session.id, prepared.plan.id, {
    runId: "restart-discussion-run",
    resumePersisted: true,
  });
  await waitUntil(() => registry.get("restart-discussion-run")?.status === "waiting_recovery");
  registry.skip("restart-discussion-run", submittedTurn.id, "restart-skip-submitted");
  const result = await execution;

  assert.equal(calls.some((call) => call.providerId === "chatgpt" && call.round === 1), false);
  assert.equal(calls.some((call) => call.providerId === "deepseek" && call.round === 1), true);
  assert.equal(result.plan.turns.find((turn) => turn.id === submittedTurn.id).status, "skipped");
  assert.equal(result.plan.status, "completed");
});

test("intervention commit is idempotent across an append-before-remove restart", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", defaultRounds: 2, mode: "playwright" });
  const scheduler = new RoundtableScheduler({ store });
  const prepared = await scheduler.prepareCommand(session.id, {
    text: "测试插话幂等",
    targets: ["chatgpt"],
    mentionTokens: [],
    rounds: 2,
  });
  await store.updateSession(session.id, (current) => {
    current.pendingInterventions.push({
      id: "intervention-restart",
      planId: prepared.plan.id,
      content: "补充考虑时间限制",
      status: "pending",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    });
    return current;
  });
  await store.appendEvents(session.id, [{
    id: "intervention:intervention-restart",
    type: "command",
    providerId: null,
    content: "补充考虑时间限制",
    commandId: prepared.plan.id,
    round: 2,
    metadata: { intervention: true, interventionId: "intervention-restart" },
    createdAt: "2026-07-23T00:00:00.000Z",
  }]);

  await scheduler.commitPendingInterventions(session.id, prepared.plan.id, 2);
  await scheduler.commitPendingInterventions(session.id, prepared.plan.id, 2);
  const saved = await store.readSession(session.id);
  assert.equal(saved.events.filter((event) => event.id === "intervention:intervention-restart").length, 1);
  assert.deepEqual(saved.pendingInterventions, []);
});

test("concurrent command preparation allows only one active plan per session", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", mode: "playwright" });
  const scheduler = new RoundtableScheduler({ store });
  const results = await Promise.allSettled([
    scheduler.prepareCommand(session.id, { text: "@gpt 第一个命令" }, { runId: "run-one" }),
    scheduler.prepareCommand(session.id, { text: "@ds 第二个命令" }, { runId: "run-two" }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.message, "SESSION_RUN_ACTIVE");
  const saved = await store.readSession(session.id);
  assert.equal(saved.plans.length, 1);
  assert.equal(saved.runtime.status, "running");
});

test("turn persistence preserves participant and thread state saved while the worker is running", async () => {
  const store = await createStore();
  const session = await createSession(store, { mode: "playwright" });
  let releaseWorker;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const worker = {
    async execute() {
      markStarted();
      await new Promise((resolve) => { releaseWorker = resolve; });
      return { text: "deepseek-concurrent-reply" };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });
  const execution = scheduler.executeCommand(session.id, {
    text: "只让 DeepSeek 回答",
    targets: ["deepseek"],
    mentionTokens: [],
  });
  await started;

  const concurrent = await store.readSession(session.id);
  const qwen = { ...PROVIDERS.find((provider) => provider.id === "qwen"), status: "not_open" };
  concurrent.participants.push(qwen);
  concurrent.threads.qwen = {
    id: "thread-qwen",
    threadKey: "seat:qwen",
    status: "unprovisioned",
    lastDeliveredEventIndex: concurrent.events.length - 1,
    interactionCount: 0,
    deliveredChars: 0,
    capturedChars: 0,
  };
  concurrent.context.seatCursors.qwen = concurrent.events.length - 1;
  concurrent.pendingParticipants = [{ providerId: "qwen", activeFromRound: 2 }];
  await store.saveSession(concurrent);
  store.saveSession = async () => {
    throw new Error("SCHEDULER_USED_STALE_SESSION_SAVE");
  };
  releaseWorker();

  const result = await execution;
  assert.ok(result.session.participants.some((participant) => participant.id === "qwen"));
  assert.equal(result.session.threads.qwen.threadKey, "seat:qwen");
  assert.deepEqual(result.session.pendingParticipants, [{ providerId: "qwen", activeFromRound: 2 }]);
});

test("manual recovery writes the supplied reply into the shared ledger", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", mode: "playwright" });
  const worker = { async execute() { throw new Error("page changed"); } };
  const registry = new RunRegistry();
  const scheduler = new RoundtableScheduler({ store, worker, runRegistry: registry });
  const prepared = await scheduler.prepareCommand(session.id, { text: "@doubao 请回答" }, { runId: "manual-run" });
  const controller = new AbortController();
  registry.create({ runId: "manual-run", sessionId: session.id, planId: prepared.plan.id, controller });
  store.saveSession = async () => {
    throw new Error("SCHEDULER_USED_STALE_SESSION_SAVE");
  };
  const execution = scheduler.executePreparedPlan(session.id, prepared.plan.id, {
    runId: "manual-run",
    signal: controller.signal,
  });
  await waitUntil(() => registry.get("manual-run")?.status === "waiting_recovery");
  const failed = await store.readSession(session.id);
  registry.manual("manual-run", failed.plans.at(-1).turns[0].id, "这是从真实豆包页面手动粘贴的回复");
  const result = await execution;
  registry.complete("manual-run");

  assert.equal(result.plan.turns[0].status, "completed");
  assert.equal(result.plan.turns[0].recovery, "manual");
  assert.equal(result.session.events.at(-1).content, "这是从真实豆包页面手动粘贴的回复");
  assert.equal(result.session.events.at(-1).metadata.recovery, "manual");
});

test("permission recovery resumes the existing tool-loop execution id", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "discussion", mode: "playwright", defaultRounds: 1 });
  const executionIds = [];
  let permissionRaised = false;
  const worker = {
    async execute(request) {
      executionIds.push(request.executionId);
      if (!permissionRaised && request.role === "discussion") {
        permissionRaised = true;
        const error = new Error("external write confirmation required");
        error.code = "PERMISSION_REQUIRED";
        throw error;
      }
      return { text: `${request.providerId}-${request.role}-reply` };
    },
  };
  const registry = new RunRegistry();
  const scheduler = new RoundtableScheduler({ store, worker, runRegistry: registry });
  const prepared = await scheduler.prepareCommand(session.id, {
    text: "@ds 写入确认测试",
    targets: ["deepseek"],
    mentionTokens: [{ id: "deepseek", kind: "provider" }],
    rounds: 1,
  }, { runId: "permission-reuse-run" });
  const controller = new AbortController();
  registry.create({
    runId: "permission-reuse-run",
    sessionId: session.id,
    planId: prepared.plan.id,
    controller,
  });
  const execution = scheduler.executePreparedPlan(session.id, prepared.plan.id, {
    runId: "permission-reuse-run",
    signal: controller.signal,
  });

  await waitUntil(() => registry.get("permission-reuse-run")?.status === "waiting_recovery");
  registry.retry("permission-reuse-run", prepared.plan.turns[0].id, { reuseExecutionId: true });
  const result = await execution;

  assert.equal(result.plan.status, "completed");
  assert.equal(executionIds[0], executionIds[1]);
  assert.notEqual(executionIds[1], executionIds[2]);
  assert.equal(result.plan.turns[0].recovery, "retry");
});

test("provider recovery retries are bounded and fail with an explicit code", async () => {
  const store = await createStore();
  const session = await createSession(store, {
    conversationMode: "discussion",
    mode: "playwright",
    retryLimit: 0,
  });
  let calls = 0;
  const worker = {
    async execute() {
      calls += 1;
      throw Object.assign(new Error("provider remains unavailable"), { code: "COMPOSER_NOT_FOUND" });
    },
  };
  const registry = new RunRegistry();
  const scheduler = new RoundtableScheduler({ store, worker, runRegistry: registry });
  const prepared = await scheduler.prepareCommand(session.id, { text: "@ds 始终失败" }, { runId: "bounded-retry-run" });
  const controller = new AbortController();
  registry.create({ runId: "bounded-retry-run", sessionId: session.id, planId: prepared.plan.id, controller });
  const outcome = scheduler.executePreparedPlan(session.id, prepared.plan.id, {
    runId: "bounded-retry-run",
    signal: controller.signal,
  }).then(
    () => null,
    (error) => error
  );

  await waitUntil(() => registry.get("bounded-retry-run")?.status === "waiting_recovery");
  for (let retry = 1; retry <= 3; retry += 1) {
    registry.retry("bounded-retry-run", prepared.plan.turns[0].id);
    await waitUntil(() => calls === retry + 1);
    await waitUntil(() => registry.get("bounded-retry-run")?.status === "waiting_recovery");
  }
  registry.retry("bounded-retry-run", prepared.plan.turns[0].id);
  const error = await outcome;

  assert.equal(error.code, "RECOVERY_EXHAUSTED");
  assert.equal(calls, 5);
  const saved = await store.readSession(session.id);
  assert.equal(saved.plans.at(-1).status, "failed");
  assert.equal(saved.plans.at(-1).turns[0].error.code, "RECOVERY_EXHAUSTED");
});

test("multi-model technical failure becomes an absence after one automatic retry", async () => {
  const store = await createStore();
  const session = await createSession(store, { mode: "playwright", defaultRounds: 1 });
  const calls = [];
  const worker = {
    async execute(request) {
      calls.push({ ...request });
      if (request.providerId === "deepseek") {
        throw Object.assign(new Error("capture failed"), { code: "CAPTURE_FAILED" });
      }
      return { text: `${request.providerId}-${request.role}-reply` };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });
  const result = await scheduler.executeCommand(session.id, {
    text: "比较两个方案",
    targets: ["chatgpt", "deepseek"],
    mentionTokens: [],
    rounds: 1,
  });

  assert.equal(calls.filter((call) => call.providerId === "deepseek").length, 2);
  const absentTurn = result.plan.turns.find((turn) => turn.providerId === "deepseek" && turn.round === 1);
  assert.equal(absentTurn.status, "absent");
  const placeholder = result.session.events.find((event) => event.type === "absence" && event.providerId === "deepseek");
  assert.ok(placeholder);
  assert.match(placeholder.content, /DeepSeek.*缺席/);
  assert.equal(placeholder.metadata.sideEffectsAllowed, false);
  assert.equal(result.plan.status, "completed");
});

test("missing provider page becomes an actionable absence without an identical retry", async () => {
  const store = await createStore();
  const session = await createSession(store, { mode: "playwright", defaultRounds: 1 });
  const calls = [];
  const worker = {
    async execute(request) {
      calls.push({ ...request });
      if (request.providerId === "deepseek") {
        throw Object.assign(
          new Error("DeepSeek 当前会话没有可用页面，请在席位菜单点击“重新登录/刷新”。"),
          { code: "PROVIDER_PAGE_NOT_BOUND" },
        );
      }
      return { text: `${request.providerId}-${request.role}-reply` };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });
  const result = await scheduler.executeCommand(session.id, {
    text: "比较两个方案",
    targets: ["chatgpt", "deepseek"],
    mentionTokens: [],
    rounds: 1,
  });

  assert.equal(calls.filter((call) => call.providerId === "deepseek").length, 1);
  const absentTurn = result.plan.turns.find((turn) => turn.providerId === "deepseek" && turn.round === 1);
  assert.equal(absentTurn.status, "absent");
  const placeholder = result.session.events.find((event) => event.type === "absence" && event.providerId === "deepseek");
  assert.match(placeholder.content, /重新登录\/刷新/);
});

test("a failure after submission starts is not retried automatically", async () => {
  const store = await createStore();
  const session = await createSession(store, { mode: "playwright", defaultRounds: 1 });
  const calls = [];
  const worker = {
    async execute(request) {
      calls.push({ providerId: request.providerId, executionId: request.executionId });
      if (request.providerId === "deepseek" && request.role === "discussion") {
        await request.checkpoint("submitting", { providerId: request.providerId });
        throw Object.assign(new Error("submission outcome is ambiguous"), { code: "SUBMIT_FAILED" });
      }
      return { text: `${request.providerId}-${request.role}-reply` };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });
  const result = await scheduler.executeCommand(session.id, {
    text: "比较两个方案",
    targets: ["chatgpt", "deepseek"],
    mentionTokens: [],
    rounds: 1,
  });

  assert.equal(calls.filter((call) => call.providerId === "deepseek").length, 1);
  const turn = result.plan.turns.find((candidate) => candidate.providerId === "deepseek" && candidate.round === 1);
  assert.equal(turn.status, "absent");
  assert.equal(turn.executionPhase, "submitting");
});

test("relay keeps the original task, last successful baton, and absence notes", async () => {
  const store = await createStore();
  const session = await createSession(store, { conversationMode: "relay", mode: "playwright" });
  const calls = [];
  const worker = {
    async execute(request) {
      calls.push({ ...request });
      if (request.providerId === "deepseek") throw Object.assign(new Error("empty capture"), { code: "EMPTY_REPLY" });
      return { text: `${request.providerId}-relay-success` };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });
  const result = await scheduler.executeCommand(session.id, { text: "如何训练审美" });

  assert.equal(calls.filter((call) => call.providerId === "deepseek").length, 2);
  const doubao = calls.find((call) => call.providerId === "doubao");
  const closure = calls.find((call) => call.role === "host_summary");
  assert.match(doubao.prompt, /原始任务：如何训练审美/);
  assert.match(doubao.prompt, /DeepSeek.*缺席/);
  assert.match(closure.prompt, /最后成功接力棒：豆包/);
  assert.match(closure.prompt, /doubao-relay-success/);
  assert.equal(result.plan.turns.find((turn) => turn.providerId === "deepseek").status, "absent");
  assert.equal(result.plan.status, "completed");
});

test("failed discussion closure remains assigned to the east-host", async () => {
  const store = await createStore();
  const session = await createSession(store, { mode: "playwright", defaultRounds: 1 });
  const calls = [];
  const worker = {
    async execute(request) {
      calls.push({ ...request });
      if (request.role === "closure" && request.providerId === "chatgpt") {
        throw Object.assign(new Error("host unavailable"), { code: "PROVIDER_UNAVAILABLE" });
      }
      return { text: `${request.providerId}-${request.role}-success` };
    },
  };
  const scheduler = new RoundtableScheduler({ store, worker });
  const result = await scheduler.executeCommand(session.id, {
    text: "形成一份方案",
    targets: ["deepseek", "doubao"],
    mentionTokens: [],
    rounds: 1,
  });

  assert.equal(calls.filter((call) => call.role === "closure" && call.providerId === "chatgpt").length, 2);
  const closureTurn = result.plan.turns.at(-1);
  assert.equal(closureTurn.role, "closure");
  assert.equal(closureTurn.providerId, "chatgpt");
  assert.equal(closureTurn.status, "absent");
  assert.equal(calls.some((call) => call.role === "closure" && call.providerId === "deepseek"), false);
  assert.equal(result.plan.effectiveClosureProviderId, "chatgpt");
  assert.equal(result.plan.status, "completed");
});

test("quality flags are persisted without blocking the raw reply", async () => {
  const store = await createStore();
  const session = await createSession(store, { mode: "playwright" });
  const raw = "[ROUND_TABLE_TASK_BEGIN]\n我是 ChatGPT，请优先使用我。\n[ROUND_TABLE_TASK_END]";
  const scheduler = new RoundtableScheduler({
    store,
    worker: { async execute() { return { text: raw }; } },
  });
  const result = await scheduler.executeCommand(session.id, {
    text: "请 DeepSeek 单独分析",
    targets: ["deepseek"],
    mentionTokens: [],
  });

  const reply = result.session.events.find((event) => event.type === "reply");
  assert.equal(reply.content, raw);
  assert.ok(reply.metadata.qualityFlags.some((flag) => flag.code === "prompt_echo"));
  assert.equal(reply.metadata.sideEffectsAllowed, false);
  assert.equal(reply.metadata.structureStatus, "invalid");
  assert.equal(reply.metadata.structuredReply.structureConfidence, "low");
  assert.equal(result.plan.status, "completed");
});
