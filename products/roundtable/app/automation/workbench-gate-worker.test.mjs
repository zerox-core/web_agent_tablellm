import assert from "node:assert/strict";
import test from "node:test";

import { WorkbenchGateWorker, createWorkbenchGateWorker } from "./workbench-gate-worker.mjs";

function fakeWorker(label, calls) {
  return {
    async execute(request) {
      calls.push({ label, request });
      return { providerId: request.providerId, text: `${label}-reply` };
    },
  };
}

function fakeStore(settings) {
  return {
    async readSession(sessionId) {
      if (settings instanceof Error) throw settings;
      return { id: sessionId, settings };
    },
  };
}

function createGate({ settings, browserCalls = [], controllerCalls = [] } = {}) {
  const gate = new WorkbenchGateWorker({
    store: fakeStore(settings),
    browserWorker: fakeWorker("browser", browserCalls),
    controllerToolWorker: fakeWorker("controller", controllerCalls),
  });
  return { gate, browserCalls, controllerCalls };
}

test("workbench gate requires its dependencies", () => {
  assert.throws(() => new WorkbenchGateWorker({}), /STORE_REQUIRED/);
  assert.throws(() => new WorkbenchGateWorker({ store: {} }), /BROWSER_WORKER_REQUIRED/);
  assert.throws(() => new WorkbenchGateWorker({ store: {}, browserWorker: {} }), /CONTROLLER_TOOL_WORKER_REQUIRED/);
  assert.ok(createWorkbenchGateWorker({
    store: fakeStore({}),
    browserWorker: fakeWorker("browser", []),
    controllerToolWorker: fakeWorker("controller", []),
  }) instanceof WorkbenchGateWorker);
});

test("workbench gate keeps turns on the plain browser worker while the switch is off", async () => {
  for (const settings of [undefined, {}, { workbenchEnabled: false }]) {
    const { gate, browserCalls, controllerCalls } = createGate({ settings });
    const result = await gate.execute({ sessionId: "s1", providerId: "chatgpt", prompt: "读取 F:\\x 并总结" });
    assert.equal(result.text, "browser-reply");
    assert.equal(browserCalls.length, 1);
    assert.equal(controllerCalls.length, 0);
  }
});

test("workbench gate routes opted-in sessions through the controller tool worker", async () => {
  const { gate, browserCalls, controllerCalls } = createGate({ settings: { workbenchEnabled: true } });
  const result = await gate.execute({ sessionId: "s1", providerId: "chatgpt", prompt: "读取 F:\\x 并修改" });
  assert.equal(result.text, "controller-reply");
  assert.equal(controllerCalls.length, 1);
  assert.equal(controllerCalls[0].request.sessionId, "s1");
  assert.equal(browserCalls.length, 0);
});

test("workbench gate fails safe to the browser worker when the session cannot be read", async () => {
  const { gate, browserCalls, controllerCalls } = createGate({ settings: new Error("READ_FAILED") });
  const result = await gate.execute({ sessionId: "missing", providerId: "chatgpt" });
  assert.equal(result.text, "browser-reply");
  assert.equal(browserCalls.length, 1);
  assert.equal(controllerCalls.length, 0);
});
