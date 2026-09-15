import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";

import {
  appendSessionEvent,
  buildPrompt,
  createTurnPlan,
  createRoundtableServer,
  createSession,
  createDefaultLayout,
  executeRoundtableCommand,
  parseRoundtableCommand,
  readSession,
  updateParticipantOrder,
  updateParticipantLayout,
  writeSummary,
} from "./server.mjs";

test("roundtable static UI uses workspace gating and one structured composer", async () => {
  const [indexHtml, appJs, styles] = await Promise.all([
    fs.readFile(new URL("./public/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("./public/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("./public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(indexHtml, /id="workspaceDialog"/);
  assert.match(indexHtml, /id="sessionSelectTop"/);
  assert.match(indexHtml, /id="commandInput"/);
  assert.match(indexHtml, /id="mentionSuggestions"/);
  assert.doesNotMatch(indexHtml, /id="taskForm"|id="taskTitle"|id="taskObjective"|id="dataRootInput"/);
  assert.match(appJs, /targets: preview\.targets/);
  assert.match(appJs, /references: preview\.references/);
  assert.match(appJs, /\["deepseek", "doubao"\]\.includes/);
  assert.doesNotMatch(appJs, /\["chatgpt", "deepseek", "doubao"\]\.includes\(provider\.id\)/);
  assert.match(styles, /\.host-snap/);
  assert.match(styles, /\.seat-avatar/);
  assert.match(styles, /\.seat-spokes line/);
  assert.match(styles, /@media \(max-width: 520px\)/);
});

test("roundtable session writes ledger, events, and summary", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-"));
  const session = await createSession(
    {
      title: "测试任务",
      objective: "比较两个实现方案",
      participants: ["chatgpt", "qwen"],
    },
    { repoRoot }
  );

  assert.equal(session.participants.length, 2);
  assert.match(session.id, /^\d{8}-\d{6}-/);

  const appended = await appendSessionEvent(
    session.id,
    { type: "reply", providerId: "chatgpt", content: "先做启动器。" },
    { repoRoot }
  );
  assert.equal(appended.event.providerId, "chatgpt");

  const prompt = buildPrompt(appended.session, "qwen");
  assert.match(prompt, /你正在参加一场/);
  assert.match(prompt, /先做启动器/);

  const summary = await writeSummary(session.id, { summary: "结论：先做最小圆桌。" }, { repoRoot });
  assert.match(summary.filePath, /summary\.md$/);
  assert.match(await fs.readFile(summary.filePath, "utf8"), /先做最小圆桌/);

  const saved = await readSession(session.id, { repoRoot });
  assert.equal(saved.summary.text, "结论：先做最小圆桌。");
});

test("roundtable HTTP API creates session and returns prompts", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-"));
  const server = createRoundtableServer({ repoRoot });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Roundtable API",
        objective: "验证接口",
        participants: ["chatgpt", "deepseek"],
        openThreads: false,
      }),
    }).then((response) => response.json());

    assert.equal(created.ok, true);
    assert.equal(created.session.participants.length, 2);

    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    assert.ok(["dual_write", "json_fallback"].includes(health.controlStore.mode));
    assert.equal(health.controlStore.schemaVersion, 2);
    assert.equal(
      health.controlStore.migrationStatus,
      health.controlStore.available ? "current" : health.controlStore.enabled ? "failed" : "disabled",
    );
    assert.equal(typeof health.controlStore.conflictCount, "number");
    const executions = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(created.session.id)}/executions`).then((response) => response.json());
    assert.equal(executions.source, health.controlStore.available ? "sqlite_primary" : "json");
    assert.deepEqual(executions.executions, []);

    const prompt = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(created.session.id)}/prompt?provider=deepseek`
    ).then((response) => response.json());
    assert.equal(prompt.ok, true);
    assert.match(prompt.prompt, /验证接口/);
  } finally {
    server.close();
  }
});

test("execution API reads SQLite first and falls back to JSON when disabled", async (t) => {
  const sqliteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-primary-"));
  const sqliteServer = createRoundtableServer({ repoRoot: sqliteRoot, sqliteControlEnabled: true });
  sqliteServer.listen(0, "127.0.0.1");
  await once(sqliteServer, "listening");
  t.after(() => sqliteServer.close());
  const sqliteBase = `http://127.0.0.1:${sqliteServer.address().port}`;
  const created = await fetch(`${sqliteBase}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "SQLite primary", objective: "", participants: ["chatgpt"], openThreads: false }),
  }).then((response) => response.json());
  const stale = {
    executionId: "exec-primary",
    attemptId: "attempt-primary",
    idempotencyKey: "logical-primary",
    sessionId: created.session.id,
    planId: "plan",
    turnId: "turn",
    providerId: "chatgpt",
    status: "running",
    executionPhase: "capturing",
    sendState: "SENT",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:01.000Z",
  };
  await sqliteServer.runtime.store.updateSession(created.session.id, (session) => {
    session.executionIndex = [stale];
    return session;
  });
  sqliteServer.runtime.controlStore.upsertExecution({
    ...stale,
    status: "completed",
    executionPhase: "committed",
    sendState: "COMMITTED",
    updatedAt: "2026-07-21T00:00:02.000Z",
  });
  const primary = await fetch(`${sqliteBase}/api/sessions/${encodeURIComponent(created.session.id)}/executions`)
    .then((response) => response.json());
  assert.equal(primary.source, "sqlite_primary");
  assert.equal(primary.executions[0].sendState, "COMMITTED");

  const jsonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-json-"));
  const jsonServer = createRoundtableServer({ repoRoot: jsonRoot, sqliteControlEnabled: false });
  jsonServer.listen(0, "127.0.0.1");
  await once(jsonServer, "listening");
  t.after(() => jsonServer.close());
  const jsonBase = `http://127.0.0.1:${jsonServer.address().port}`;
  const jsonCreated = await fetch(`${jsonBase}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "JSON fallback", objective: "", participants: ["chatgpt"], openThreads: false }),
  }).then((response) => response.json());
  const fallback = await fetch(`${jsonBase}/api/sessions/${encodeURIComponent(jsonCreated.session.id)}/executions`)
    .then((response) => response.json());
  assert.equal(fallback.source, "json");
  assert.equal(jsonServer.runtime.controlStore.describe().migrationStatus, "disabled");
});

test("roundtable command parser resolves all, single target, and pair discussion", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-"));
  const session = await createSession(
    {
      title: "自动圆桌",
      objective: "证明一个课题",
      participants: ["chatgpt", "gemini", "doubao"],
      settings: { defaultRounds: 3 },
    },
    { repoRoot }
  );

  const all = parseRoundtableCommand("@全体 我们来看看如何证明这个课题", session, session.settings);
  assert.deepEqual(all.targets, ["chatgpt", "gemini", "doubao"]);
  assert.equal(all.rounds, 3);

  const single = parseRoundtableCommand("@gpt 你看看豆包说的问题", session, session.settings);
  assert.deepEqual(single.targets, ["chatgpt"]);
  assert.equal(single.rounds, 1);

  const pair = parseRoundtableCommand("@gemini 你和 @gpt 进行讨论你俩的方案", session, session.settings);
  assert.deepEqual(pair.targets, ["gemini", "chatgpt"]);
  assert.equal(pair.rounds, 3);

  const plan = createTurnPlan(session, pair.commandText, session.settings);
  assert.equal(plan.turns.length, 2);
  assert.deepEqual(plan.turns.map((turn) => `${turn.round}:${turn.providerId}`), [
    "1:gemini",
    "1:chatgpt",
  ]);
  assert.equal(plan.maxCycles, 3);
  assert.deepEqual(plan.cycles[0].turnIds, plan.turns.map((turn) => turn.id));
  assert.equal(plan.turns.every((turn) => turn.countsTowardRounds), true);
});

test("executeRoundtableCommand writes command plan and mock replies", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-"));
  const session = await createSession(
    {
      title: "自动执行",
      objective: "验证 mock 自动发言",
      participants: ["chatgpt", "gemini"],
      settings: { defaultRounds: 3, mode: "mock" },
    },
    { repoRoot }
  );

  const result = await executeRoundtableCommand(
    session.id,
    { text: "@gemini 你和 @gpt 进行讨论你俩的方案" },
    { repoRoot }
  );

  assert.equal(result.plan.status, "completed");
  assert.equal(result.plan.turns.length, 7);
  assert.equal(result.session.events.filter((event) => event.type === "command").length, 1);
  assert.equal(result.session.events.filter((event) => event.type === "reply").length, 7);
  assert.deepEqual(
    result.session.events
      .filter((event) => event.type === "reply")
      .map((event) => `${event.round}:${event.providerId}`),
    ["1:gemini", "1:chatgpt", "2:gemini", "2:chatgpt", "3:gemini", "3:chatgpt", "null:chatgpt"]
  );
  assert.equal(result.session.events.filter((event) => event.type === "reply").at(-1).metadata.visibleClosure, true);

  const saved = await readSession(session.id, { repoRoot });
  assert.equal(saved.plans[0].rounds, 3);
});

test("discussion mode merges completed round output into the next round context", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-"));
  const session = await createSession(
    {
      title: "共享上下文",
      objective: "验证逐轮归并",
      participants: ["chatgpt", "gemini"],
      settings: { conversationMode: "discussion", defaultRounds: 2, mode: "mock" },
    },
    { repoRoot }
  );

  const result = await executeRoundtableCommand(
    session.id,
    { text: "@全体 一起讨论两轮" },
    { repoRoot }
  );

  const roundOnePrompts = result.plan.turns.filter((turn) => turn.round === 1).map((turn) => turn.prompt);
  const roundTwoPrompts = result.plan.turns.filter((turn) => turn.round === 2).map((turn) => turn.prompt);
  assert.equal(roundOnePrompts.every((prompt) => !prompt.includes("[Mock ChatGPT · 第 1 轮]")), true);
  assert.equal(roundTwoPrompts.every((prompt) => prompt.includes("[Mock ChatGPT · 第 1 轮]")), true);
  assert.equal(roundTwoPrompts.every((prompt) => prompt.includes("[Mock Gemini · 第 1 轮]")), true);
});

test("relay mode follows seat order and returns to the host for final summary", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-"));
  const session = await createSession(
    {
      title: "传递问答",
      objective: "如何训练审美",
      participants: ["chatgpt", "deepseek", "doubao"],
      settings: { conversationMode: "relay", mode: "mock" },
    },
    { repoRoot }
  );

  const result = await executeRoundtableCommand(session.id, { text: "如何训练审美" }, { repoRoot });
  assert.deepEqual(result.plan.route, ["deepseek", "doubao", "chatgpt"]);
  assert.equal(result.plan.turns.at(-1).role, "host_summary");
  assert.deepEqual(
    result.session.events.filter((event) => event.type === "reply").map((event) => event.providerId),
    ["deepseek", "doubao", "chatgpt"]
  );
  assert.match(result.plan.turns[1].prompt, /Mock DeepSeek/);
  assert.match(result.plan.turns[2].prompt, /Mock 豆包/);
  assert.match(result.session.events.at(-1).content, /东家总结/);
});

test("participant order makes the top seat the host", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-"));
  const session = await createSession(
    {
      title: "席位排序",
      participants: ["chatgpt", "deepseek", "doubao"],
    },
    { repoRoot }
  );

  const reordered = await updateParticipantOrder(
    session.id,
    { order: ["doubao", "deepseek", "chatgpt"] },
    { repoRoot }
  );
  assert.equal(reordered.hostId, "doubao");
  assert.deepEqual(reordered.participants.map((participant) => participant.id), ["doubao", "deepseek", "chatgpt"]);
});

test("free node layout persists positions and only a snapped node can be host", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-agents-roundtable-"));
  const session = await createSession(
    {
      title: "自由节点",
      participants: ["chatgpt", "deepseek", "doubao"],
      settings: { conversationMode: "relay", mode: "mock" },
    },
    { repoRoot }
  );

  const defaults = createDefaultLayout(session.participants);
  assert.equal(defaults.chatgpt.x, 0.5);
  assert.ok(defaults.chatgpt.y > 0.24 && defaults.chatgpt.y < 0.3);

  const withoutHost = await updateParticipantLayout(
    session.id,
    {
      hostId: null,
      order: ["chatgpt", "deepseek", "doubao"],
      layout: {
        chatgpt: { x: 0.2, y: 0.35 },
        deepseek: { x: 0.75, y: 0.4 },
        doubao: { x: 0.48, y: 0.8 },
      },
    },
    { repoRoot }
  );
  assert.equal(withoutHost.hostId, null);
  await assert.rejects(
    () => executeRoundtableCommand(session.id, { text: "开始传递" }, { repoRoot }),
    /RELAY_HOST_REQUIRED/
  );

  const withNewHost = await updateParticipantLayout(
    session.id,
    {
      hostId: "doubao",
      order: ["chatgpt", "deepseek", "doubao"],
      layout: {
        chatgpt: { x: 0.2, y: 0.35 },
        deepseek: { x: 0.75, y: 0.4 },
        doubao: { x: 0.5, y: 0.16 },
      },
    },
    { repoRoot }
  );
  assert.equal(withNewHost.hostId, "doubao");
  assert.equal(withNewHost.participants[0].id, "doubao");
  assert.deepEqual(withNewHost.layout.doubao, { x: 0.5, y: 0.16 });
});
