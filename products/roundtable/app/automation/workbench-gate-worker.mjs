// Gates the local workbench (MCP tool read/write loop) behind the per-session
// workbenchEnabled switch. The roundtable exists to discuss plans, so the
// switch defaults to off: turns then run through the plain browser worker and
// model text stays pure discussion — no tool call is parsed or executed.
// When a session opts in, turns route through the controller tool worker,
// whose authority broker enforces the collaboration rules (single designated
// writer, confidence gating, permission prompts, rollbackable transactions).
export class WorkbenchGateWorker {
  constructor({ store, browserWorker, controllerToolWorker } = {}) {
    if (!store) throw new Error("STORE_REQUIRED");
    if (!browserWorker) throw new Error("BROWSER_WORKER_REQUIRED");
    if (!controllerToolWorker) throw new Error("CONTROLLER_TOOL_WORKER_REQUIRED");
    this.store = store;
    this.browserWorker = browserWorker;
    this.controllerToolWorker = controllerToolWorker;
  }

  async execute(request = {}) {
    if (await this.#workbenchEnabled(request)) {
      return this.controllerToolWorker.execute(request);
    }
    return this.browserWorker.execute(request);
  }

  async #workbenchEnabled(request) {
    try {
      const session = await this.store.readSession(request.sessionId);
      return session?.settings?.workbenchEnabled === true;
    } catch {
      // Fail safe: when the session cannot be read, the workbench stays off.
      return false;
    }
  }
}

export function createWorkbenchGateWorker(deps) {
  return new WorkbenchGateWorker(deps);
}
