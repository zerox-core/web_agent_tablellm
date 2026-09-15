import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeResponseText,
  responseStructureComplete,
  selectNewResponseCandidate,
  isTransientPlaceholderText,
  waitForCompletedResponse,
} from "./completion-detector.mjs";
import { ChatGptAdapter } from "./adapters/chatgpt.mjs";
import { DoubaoAdapter } from "./adapters/doubao.mjs";

test("completion detector normalizes streaming whitespace", () => {
  assert.equal(normalizeResponseText("  hello  \n\n\n world \r\n"), "hello\n\n world");
});

test("completion detector returns the newest response absent from baseline", () => {
  const baseline = [{ selector: ".reply", index: 0, identity: "reply-1", text: "old reply" }];
  const current = [
    { selector: ".reply", index: 0, identity: "reply-1", text: "old reply" },
    { selector: ".reply", index: 1, identity: "reply-2", text: "new reply" },
  ];
  assert.equal(selectNewResponseCandidate(current, baseline).text, "new reply");
});

test("completion detector accepts an identical reply from a new message node", () => {
  const baseline = [{ selector: ".reply", index: 0, identity: "reply-1", text: "EXACT_TOKEN" }];
  const current = [
    { selector: ".reply", index: 0, identity: "reply-1", text: "EXACT_TOKEN" },
    { selector: ".reply", index: 1, identity: "reply-2", text: "EXACT_TOKEN" },
  ];
  assert.equal(selectNewResponseCandidate(current, baseline).identity, "reply-2");
});

test("completion detector accepts settled natural Markdown with inline braces", () => {
  assert.equal(responseStructureComplete("结论：保留原文。\n\n示例对象为 `{ key: value }`。"), true);
  assert.equal(responseStructureComplete("```json\n{\"key\":\"value\""), false);
});

test("completion detector does not settle while a JSON reply is still open", async () => {
  const incomplete = '{"schema":"web-agents-roundtable.reply.v1","summary":"处理中","risks":';
  const complete = '{"schema":"web-agents-roundtable.reply.v1","summary":"完成","claims":[],"evidence":[],"risks":[],"disagreements":[],"actions":[],"missingEvidence":[],"confidence":"candidate"}';
  let polls = 0;
  const adapter = {
    id: "doubao",
    label: "豆包",
    async assertAutomationReady() {},
    async collectResponseCandidates() {
      polls += 1;
      return [{ selector: ".reply", index: 0, identity: "reply-1", text: polls < 8 ? incomplete : complete }];
    },
    async isBusy() { return false; },
  };

  const result = await waitForCompletedResponse({
    page: {},
    adapter,
    timeoutMs: 500,
    settleMs: 15,
    pollMs: 5,
  });

  assert.equal(result.text, complete);
  assert.ok(polls >= 8);
});

test("completion detector reports partial text without trusting callback success", async () => {
  let polls = 0;
  let progressCalls = 0;
  const adapter = {
    id: "chatgpt",
    label: "ChatGPT",
    async assertAutomationReady() {},
    async collectResponseCandidates() {
      polls += 1;
      return [{ selector: ".reply", index: 0, identity: "reply-new", text: polls < 3 ? "partial answer" : "complete answer" }];
    },
    async isBusy() { return polls < 3; },
  };

  const result = await waitForCompletedResponse({
    page: {},
    adapter,
    timeoutMs: 300,
    settleMs: 10,
    pollMs: 5,
    progressThrottleMs: 0,
    onProgress: async () => {
      progressCalls += 1;
      throw new Error("disconnected SSE");
    },
  });

  assert.equal(result.text, "complete answer");
  assert.ok(progressCalls >= 2);
});

test("ChatGPT adapter recognizes the current OpenAI login origin", () => {
  const adapter = new ChatGptAdapter();

  assert.equal(adapter.urlMatchesLogin({ url: () => "https://auth.openai.com/log-in-or-create-account" }), true);
  assert.equal(adapter.urlMatchesLogin({ url: () => "https://chatgpt.com/" }), false);
});

test("Doubao adapter prioritizes known chat input variants before generic fallbacks", () => {
  const adapter = new DoubaoAdapter();

  assert.deepEqual(adapter.inputSelectors.slice(0, 5), [
    'textarea[data-testid*="chat"]',
    'textarea[placeholder*="发消息"]',
    'textarea[placeholder*="发送"]',
    '[data-placeholder*="发消息"][contenteditable="true"]',
    '[aria-label*="发消息"][contenteditable="true"]',
  ]);
});

test("completion detector patrols and dismisses promo overlays during capture", async () => {
  const chatPage = { id: "chat" };
  const dismissCalls = [];
  const adapter = {
    id: "doubao",
    label: "Doubao",
    async collectResponseCandidates() {
      return [{ selector: ".reply", index: 0, identity: "reply-1", text: "final answer behind overlay" }];
    },
    async isBusy() { return false; },
    async dismissBlockingOverlay(pageArg) { dismissCalls.push(pageArg); },
  };

  const result = await waitForCompletedResponse({
    page: chatPage,
    adapter,
    timeoutMs: 2000,
    settleMs: 15,
    pollMs: 5,
  });

  assert.equal(result.text, "final answer behind overlay");
  assert.ok(dismissCalls.length >= 1, "overlay patrol should run during capture");
  assert.ok(dismissCalls.every((p) => p === chatPage), "patrol must target the capture page");
});

test("completion detector follows the capture page through resolvePage", async () => {
  const mainPage = { id: "main" };
  const chatPage = { id: "chat" };
  const assertPages = [];
  const adapter = {
    id: "kimi",
    label: "Kimi",
    async assertAutomationReady(pageArg) { assertPages.push(pageArg); },
    async collectResponseCandidates(pageArg) {
      if (pageArg === chatPage) {
        return [{ selector: ".reply", index: 0, identity: "reply-new", text: "popup captured" }];
      }
      return [];
    },
    async isBusy() { return false; },
  };
  let polls = 0;
  const resolvePage = () => {
    polls += 1;
    return polls >= 2 ? chatPage : mainPage;
  };

  const result = await waitForCompletedResponse({
    page: mainPage,
    resolvePage,
    adapter,
    timeoutMs: 2000,
    settleMs: 15,
    pollMs: 5,
  });

  assert.equal(result.text, "popup captured");
  assert.ok(assertPages.includes(chatPage));
});

test("completion detector rejects transient thinking placeholders as final replies", () => {
  assert.equal(isTransientPlaceholderText("正在思考"), true);
  assert.equal(isTransientPlaceholderText("思考中…"), true);
  assert.equal(isTransientPlaceholderText("Thinking..."), true);
  assert.equal(isTransientPlaceholderText("正在生成回复"), true);
  assert.equal(isTransientPlaceholderText("正在深度思考…"), true);
  assert.equal(isTransientPlaceholderText("下面聊聊关于思考的一些方法"), false);
  assert.equal(isTransientPlaceholderText("链路正常"), false);
});

test("completion detector waits out a GLM-style thinking placeholder", async () => {
  let polls = 0;
  const adapter = {
    id: "glm",
    label: "GLM",
    async assertAutomationReady() {},
    async collectResponseCandidates() {
      polls += 1;
      return [{ selector: "[class*='markdown']", index: 0, identity: "reply-new", text: polls < 10 ? "正在思考" : "链路正常" }];
    },
    async isBusy() { return false; },
  };

  const result = await waitForCompletedResponse({
    page: {},
    adapter,
    timeoutMs: 2000,
    settleMs: 15,
    pollMs: 5,
  });

  assert.equal(result.text, "链路正常");
  assert.ok(polls >= 10);
});
