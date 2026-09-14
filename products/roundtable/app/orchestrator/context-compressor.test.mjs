import assert from "node:assert/strict";
import test from "node:test";

import {
  compressSessionContext,
  getActiveCompression,
  reviseSessionCompression,
} from "./context-compressor.mjs";

function createSession() {
  return {
    id: "session-compression",
    settings: {
      contextWindowTokens: 100,
      compressionTriggerPercent: 80,
      compressionTargetPercent: 20,
      recentRawTokenBudget: 10,
    },
    events: [
      { id: "e1", type: "reply", content: "共识：原始账本不可修改" },
      { id: "e2", type: "reply", content: "分歧：是否调用模型生成摘要" },
      { id: "e3", type: "reply", content: "证据：ledger.jsonl 的哈希保持一致" },
      { id: "e4", type: "reply", content: "决定：MVP 先使用本地规则" },
      { id: "e5", type: "reply", content: "普通观点不会被提升为共识" },
      { id: "e6", type: "command", content: "最近原文" },
    ],
    context: { seatCursors: {}, summaries: [] },
  };
}

const estimatePromptTokens = (prompt) => String(prompt).length;
const buildPrompt = (session) => session.context?.compression?.active
  ? "x".repeat(15)
  : "x".repeat(81);

test("compression triggers at 80 percent and classifies only explicit markers", () => {
  const session = createSession();
  const originalEvents = structuredClone(session.events);

  const result = compressSessionContext(session, {
    prompt: buildPrompt(session),
    buildPrompt,
    estimatePromptTokens,
    estimateEventTokens: () => 3,
    now: () => "2026-07-18T08:00:00.000Z",
    idFactory: () => "compression-1",
  });

  assert.equal(result.changed, true);
  assert.equal(result.compression.revision, 1);
  assert.equal(result.compression.coveredFromEventIndex, 0);
  assert.equal(result.compression.coveredThroughEventIndex, 2);
  assert.equal(result.compression.consensus[0].text, "原始账本不可修改");
  assert.deepEqual(result.compression.consensus[0].sourceEventIds, ["e1"]);
  assert.equal(result.compression.disagreements[0].text, "是否调用模型生成摘要");
  assert.equal(result.compression.evidence[0].text, "ledger.jsonl 的哈希保持一致");
  assert.equal(result.compression.decisions.length, 0);
  assert.equal(result.compression.unclassified.length, 0);
  assert.equal(result.compression.estimate.beforeTokens, 81);
  assert.equal(result.compression.estimate.afterTokens, 15);
  assert.equal(result.compression.estimate.targetMet, true);
  assert.deepEqual(session.events, originalEvents);
});

test("compression uses derived structure as auxiliary data without inventing consensus", () => {
  const session = createSession();
  session.events[0] = {
    id: "e1",
    type: "reply",
    content: "这是不可改写的模型原文",
    metadata: {
      structureStatus: "valid",
      structuredReply: {
        summary: "建议先验证输入链路",
        claims: ["网页原文应是主数据"],
        evidence: ["下一轮能读取 event.content"],
        risks: ["派生结构可能误判"],
        disagreements: ["是否保留旧格式"],
        actions: ["增加回归测试"],
        missingEvidence: ["真实长会话样本"],
      },
    },
  };
  const originalEvents = structuredClone(session.events);

  const result = compressSessionContext(session, {
    prompt: buildPrompt(session),
    buildPrompt,
    estimatePromptTokens,
    estimateEventTokens: () => 3,
    now: () => "2026-07-22T12:00:00.000Z",
    idFactory: () => "compression-derived",
  });

  assert.equal(result.compression.consensus.length, 0);
  assert.equal(result.compression.evidence[0].text, "下一轮能读取 event.content");
  assert.equal(result.compression.disagreements[0].text, "是否保留旧格式");
  assert.ok(result.compression.unclassified.some((entry) => entry.text === "核心判断：建议先验证输入链路"));
  assert.ok(result.compression.unclassified.some((entry) => entry.text === "风险：派生结构可能误判"));
  assert.deepEqual(session.events, originalEvents);
});

test("compression falls back to raw content when derived structure is unavailable", () => {
  const session = {
    id: "raw-fallback",
    settings: {
      contextWindowTokens: 100,
      compressionTriggerPercent: 80,
      compressionTargetPercent: 20,
      recentRawTokenBudget: 3,
    },
    events: [
      { id: "raw-1", type: "reply", content: "自然讨论原文", metadata: { structureStatus: "invalid" } },
      { id: "raw-2", type: "command", content: "最近指令" },
    ],
    context: { seatCursors: {}, summaries: [] },
  };

  const result = compressSessionContext(session, {
    prompt: "x".repeat(81),
    buildPrompt,
    estimatePromptTokens,
    estimateEventTokens: () => 3,
    idFactory: () => "compression-raw-fallback",
  });

  assert.deepEqual(result.compression.unclassified.map((entry) => entry.text), ["自然讨论原文"]);
  assert.equal(result.compression.consensus.length, 0);
  assert.equal(result.compression.evidence.length, 0);
  assert.equal(result.compression.disagreements.length, 0);
  assert.equal(result.compression.decisions.length, 0);
});

test("compression stays inactive below the trigger and is idempotent at one boundary", () => {
  const below = createSession();
  const untouched = compressSessionContext(below, {
    prompt: "x".repeat(79),
    estimatePromptTokens,
  });
  assert.equal(untouched.changed, false);
  assert.equal(getActiveCompression(below), null);

  const session = createSession();
  const options = {
    prompt: buildPrompt(session),
    buildPrompt,
    estimatePromptTokens,
    estimateEventTokens: () => 3,
    now: () => "2026-07-18T08:00:00.000Z",
    idFactory: () => "compression-1",
  };
  compressSessionContext(session, options);
  const second = compressSessionContext(session, { ...options, prompt: "x".repeat(81) });

  assert.equal(second.changed, false);
  assert.equal(session.context.compression.revisions.length, 1);
});

test("user revision preserves raw events and rejects stale or unknown sources", () => {
  const session = createSession();
  compressSessionContext(session, {
    prompt: buildPrompt(session),
    buildPrompt,
    estimatePromptTokens,
    estimateEventTokens: () => 3,
    now: () => "2026-07-18T08:00:00.000Z",
    idFactory: () => "compression-1",
  });
  const originalEvents = structuredClone(session.events);

  const revised = reviseSessionCompression(session, {
    baseRevision: 1,
    consensus: [{ id: "consensus-user", text: "账本保持只追加", sourceEventIds: ["e1"] }],
    disagreements: getActiveCompression(session).disagreements,
    evidence: getActiveCompression(session).evidence,
    decisions: [],
    unclassified: [],
  }, {
    now: () => "2026-07-18T08:05:00.000Z",
    idFactory: () => "compression-2",
  });

  assert.equal(revised.revision, 2);
  assert.equal(revised.reason, "user_revision");
  assert.equal(revised.consensus[0].text, "账本保持只追加");
  assert.equal(session.context.compression.revisions.length, 2);
  assert.deepEqual(session.events, originalEvents);

  assert.throws(
    () => reviseSessionCompression(session, { baseRevision: 1 }),
    (error) => error.code === "STALE_COMPRESSION_REVISION",
  );
  assert.throws(
    () => reviseSessionCompression(session, {
      baseRevision: 2,
      consensus: [{ id: "bad", text: "伪造来源", sourceEventIds: ["other-session-event"] }],
      disagreements: [],
      evidence: [],
      decisions: [],
      unclassified: [],
    }),
    (error) => error.code === "UNKNOWN_COMPRESSION_SOURCE_EVENT",
  );
});

test("compression records quality metrics and counts dropped unclassified entries", () => {
  const session = {
    id: "compression-metrics",
    settings: {
      contextWindowTokens: 100,
      compressionTriggerPercent: 80,
      compressionTargetPercent: 20,
      recentRawTokenBudget: 2,
    },
    events: [
      { id: "m1", type: "reply", content: "普通观点一" },
      { id: "m2", type: "reply", content: "普通观点二" },
      { id: "m3", type: "reply", content: "普通观点三" },
      { id: "m4", type: "command", content: "最近指令" },
    ],
    context: { seatCursors: {}, summaries: [] },
  };
  const shrinkingBuildPrompt = (target) => "x".repeat(
    target.context?.compression?.active
      ? 10 + 8 * target.context.compression.active.unclassified.length
      : 80,
  );

  const result = compressSessionContext(session, {
    prompt: "x".repeat(80),
    buildPrompt: shrinkingBuildPrompt,
    estimatePromptTokens,
    estimateEventTokens: () => 1,
    idFactory: () => "compression-metrics",
  });

  assert.equal(result.changed, true);
  assert.equal(result.compression.unclassified.length, 1);
  assert.equal(result.compression.estimate.targetMet, true);
  assert.equal(result.compression.metrics.entryCount, 1);
  assert.equal(result.compression.metrics.classifiedEntryCount, 0);
  assert.equal(result.compression.metrics.unclassifiedEntryCount, 1);
  assert.equal(result.compression.metrics.classifiedShare, 0);
  assert.equal(result.compression.metrics.disagreementEntryCount, 0);
  assert.equal(result.compression.metrics.droppedUnclassifiedEntryCount, 1);
  assert.equal(result.compression.providerId, null);
});

test("per-seat context window override changes the compression trigger", () => {
  const createSeatSession = () => ({
    id: "compression-seat-window",
    settings: {
      contextWindowTokens: 100,
      compressionTriggerPercent: 80,
      compressionTargetPercent: 20,
      recentRawTokenBudget: 1,
      providerContextWindowTokens: { chatgpt: 50 },
    },
    events: [
      { id: "s1", type: "reply", content: "共识：按席位独立估算" },
      { id: "s2", type: "command", content: "最近指令" },
    ],
    context: { seatCursors: {}, summaries: [] },
  });

  const seat = createSeatSession();
  const triggered = compressSessionContext(seat, {
    prompt: "x".repeat(41),
    providerId: "chatgpt",
    buildPrompt: (target) => target.context?.compression?.active ? "x".repeat(10) : "x".repeat(41),
    estimatePromptTokens,
    estimateEventTokens: () => 1,
    idFactory: () => "compression-seat",
  });
  assert.equal(triggered.changed, true);
  assert.equal(triggered.compression.providerId, "chatgpt");
  assert.equal(triggered.compression.estimate.windowTokens, 50);
  assert.equal(triggered.compression.estimate.targetMet, true);
  assert.equal(triggered.compression.metrics.classifiedEntryCount, 1);
  assert.equal(triggered.compression.metrics.droppedUnclassifiedEntryCount, 0);

  const global = createSeatSession();
  const untouched = compressSessionContext(global, {
    prompt: "x".repeat(41),
    buildPrompt: (target) => "x".repeat(41),
    estimatePromptTokens,
    estimateEventTokens: () => 1,
  });
  assert.equal(untouched.changed, false);
  assert.equal(untouched.reason, "below_trigger");
});

test("user revision recomputes quality metrics", () => {
  const session = createSession();
  compressSessionContext(session, {
    prompt: buildPrompt(session),
    buildPrompt,
    estimatePromptTokens,
    estimateEventTokens: () => 3,
    now: () => "2026-07-18T08:00:00.000Z",
    idFactory: () => "compression-1",
  });

  const revised = reviseSessionCompression(session, {
    baseRevision: 1,
    consensus: [{ id: "consensus-metrics", text: "账本保持只追加", sourceEventIds: ["e1"] }],
    disagreements: [],
    evidence: [],
    decisions: [],
    unclassified: [],
  }, {
    now: () => "2026-07-18T08:10:00.000Z",
    idFactory: () => "compression-metrics-revision",
  });

  assert.equal(revised.reason, "user_revision");
  assert.equal(revised.metrics.entryCount, 1);
  assert.equal(revised.metrics.classifiedEntryCount, 1);
  assert.equal(revised.metrics.unclassifiedEntryCount, 0);
  assert.equal(revised.metrics.classifiedShare, 1);
  assert.equal(revised.metrics.droppedUnclassifiedEntryCount, 0);
});
