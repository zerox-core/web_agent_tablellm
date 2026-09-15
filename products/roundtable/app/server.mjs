import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  PROVIDERS,
  coerceSettings,
  createDefaultLayout,
  getProvider,
  makeSessionId,
  normalizeLayout,
  uniqueProviderIds,
} from "./core/providers.mjs";
import {
  queueIntervention,
  removeIntervention,
  setDefaultSeatRole,
  updateIntervention,
} from "./core/discussion-session-state.mjs";
import { createProviderAdapters } from "./automation/adapters/index.mjs";
import { BrowserManager, sanitizePageUrl } from "./automation/browser-manager.mjs";
import { BrowserWorker } from "./automation/worker.mjs";
import { ControllerToolWorker } from "./automation/controller-tool-worker.mjs";
import { WorkbenchGateWorker } from "./automation/workbench-gate-worker.mjs";
import { ExtensionRelay } from "./automation/extension-relay.mjs";
import { ExtensionBrowserManager } from "./automation/extension-browser-manager.mjs";
import { ExtensionBrowserWorker } from "./automation/extension-worker.mjs";
import { PageLeaseRegistry } from "./automation/page-lease-registry.mjs";
import { ArtifactWriter } from "./orchestrator/artifact-writer.mjs";
import { HandoffManager } from "./orchestrator/handoff-manager.mjs";
import { parseRoundtableCommand } from "./orchestrator/command-parser.mjs";
import { buildPrompt } from "./orchestrator/context-builder.mjs";
import {
  annotateCompressionRevision,
  diffCompressionRevisions,
  getActiveCompression,
  rollbackCompressionFields,
  reviseSessionCompression,
} from "./orchestrator/context-compressor.mjs";
import { EventBus } from "./orchestrator/event-bus.mjs";
import { RunRegistry } from "./orchestrator/run-registry.mjs";
import { CommandTransferRegistry } from "./orchestrator/command-transfer.mjs";
import { RoundtableScheduler, createTurnPlan } from "./orchestrator/scheduler.mjs";
import { LocalWorkspaceStore } from "./storage/local-workspace-store.mjs";
import { SqliteControlStore } from "./storage/sqlite-control-store.mjs";
import { WorkspaceRegistry } from "./storage/workspace-registry.mjs";
import {
  CONTROLLER_TOOL_CAPABILITY,
  createFilesystemTools,
} from "@web-agents/local-core/filesystem-tools";
import { listExecutionIndex } from "./orchestrator/execution-index.mjs";
import { PermissionBroker } from "@web-agents/local-core/permissions";
import { TransactionManager } from "@web-agents/local-core/transactions";
import { defaultToolRegistry } from "@web-agents/local-core/tool-registry";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, "..", "..", "..");
const defaultPublicDir = path.join(__dirname, "public");
const defaultHost = process.env.WEB_AGENTS_ROUNDTABLE_HOST || "127.0.0.1";
const defaultPort = Number(process.env.WEB_AGENTS_ROUNDTABLE_PORT || 3020);
const SERVICE_ID = "web-agents-roundtable";
const EXTENSION_BRIDGE_PORT = 3020;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const require = createRequire(import.meta.url);
const VENDOR_FILES = new Map();
try {
  VENDOR_FILES.set("/vendor/marked.umd.js", path.join(path.dirname(require.resolve("marked")), "marked.umd.js"));
  VENDOR_FILES.set("/vendor/purify.min.js", path.join(path.dirname(require.resolve("dompurify")), "purify.min.js"));
} catch {
  // The public UI reports a normal load failure when optional browser assets are unavailable.
}

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(statusCode === 204 ? undefined : JSON.stringify(body));
}

function sendText(response, statusCode, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(text);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error("REQUEST_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

function requestPathParts(url) {
  return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function parseHttpAuthority(value) {
  try {
    return new URL(`http://${String(value || "")}`);
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase());
}

function authorizeLocalRequest(request, response, url) {
  const authority = parseHttpAuthority(request.headers.host);
  if (!authority || !isLoopbackHostname(authority.hostname)) {
    sendJson(response, 403, { ok: false, error: "LOCAL_HOST_REQUIRED" });
    return false;
  }

  const origin = request.headers.origin;
  if (origin) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      sendJson(response, 403, { ok: false, error: "LOCAL_ORIGIN_REQUIRED" });
      return false;
    }
    const samePort = (parsedOrigin.port || "80") === (authority.port || "80");
    if (parsedOrigin.protocol !== "http:" || !isLoopbackHostname(parsedOrigin.hostname) || !samePort) {
      sendJson(response, 403, { ok: false, error: "LOCAL_ORIGIN_REQUIRED" });
      return false;
    }
    response.setHeader("Access-Control-Allow-Origin", String(origin));
    response.setHeader("Vary", "Origin");
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/")) {
    const contentType = String(request.headers["content-type"] || "");
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      sendJson(response, 415, { ok: false, error: "APPLICATION_JSON_REQUIRED" });
      return false;
    }
  }

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type,accept,last-event-id");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  return true;
}

function errorStatus(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = String(error?.code || message);
  if (code === "MANUAL_BROWSER_UNAVAILABLE") return 503;
  if (["EXTENSION_BRIDGE_UNAVAILABLE", "EXTENSION_BRIDGE_CLOSED"].includes(code)) return 503;
  if (code === "EXTENSION_COMMAND_TIMEOUT") return 504;
  if (code === "PROVIDER_RESPONSE_TIMEOUT") return 504;
  if (code === "PROVIDER_PAGE_IN_USE") return 409;
  if ([
    "EXTENSION_CLIENT_NOT_FOUND",
    "EXTENSION_COMMAND_NOT_FOUND",
    "PROVIDER_TAB_NOT_FOUND",
    "TRANSACTION_NOT_FOUND",
    "ARTIFACT_NOT_FOUND",
    "HANDOFF_NOT_FOUND",
    "PARTICIPANT_NOT_FOUND",
    "RUN_NOT_FOUND",
    "PLAN_NOT_FOUND",
    "TURN_NOT_FOUND",
    "THREAD_NOT_FOUND",
    "PROVIDER_NOT_FOUND",
    "COMPRESSION_NOT_FOUND",
    "COMPRESSION_REVISION_NOT_FOUND",
    "COMMAND_TRANSFER_NOT_FOUND",
  ].includes(code)) return 404;
  if ([
    "MANUAL_BROWSER_NAVIGATION_DISABLED",
    "PROVIDER_PAGE_NOT_BOUND",
    "LOGIN_REQUIRED",
    "HUMAN_VERIFICATION_REQUIRED",
    "COMPOSER_NOT_FOUND",
    "ADAPTER_NOT_READY",
    "INPUT_BUSY",
    "SUBMIT_FAILED",
    "BROWSER_MODE_MISMATCH",
    "EXTENSION_BRIDGE_INCOMPATIBLE",
    "WORKSPACE_REQUIRED",
    "PERMISSION_REQUIRED",
    "ARTIFACT_EXTERNAL_WRITE_REQUIRES_TOOL_LOOP",
    "REPARSE_PATH_WRITE_DENIED",
    "TRANSACTION_SESSION_MISMATCH",
    "STALE_COMPRESSION_REVISION",
    "DISCUSSION_PLAN_NOT_ACTIVE",
    "PLAN_NOT_AWAITING_CONTINUATION",
    "DISCUSSION_CYCLE_LIMIT_REACHED",
    "INTERVENTION_NOT_PENDING",
    "COMMAND_TRANSFER_CHUNK_OUT_OF_ORDER",
  ].includes(code)) return 409;
  if ([
    "INVALID_PROVIDER_URL",
    "PROVIDER_URL_MISMATCH",
    "INVALID_BROWSER_BINDING",
    "INVALID_EXTENSION_CLIENT",
    "INVALID_EXTENSION_RESULT",
    "EXTENSION_REQUEST_NOT_ALLOWED",
    "WORKSPACE_PATH_MUST_BE_ABSOLUTE",
    "WORKSPACE_NOT_FOUND",
    "WORKSPACE_NOT_DIRECTORY",
    "REQUEST_NOT_FOUND",
    "INVALID_PERMISSION_DECISION",
    "UNKNOWN_COMPRESSION_SOURCE_EVENT",
    "INVALID_COMPRESSION_BUCKET",
    "INVALID_COMPRESSION_ENTRY",
    "DUPLICATE_COMPRESSION_ENTRY",
    "INVALID_COMPRESSION_REVISION",
    "INVALID_COMPRESSION_FIELDS",
    "INVALID_COMPRESSION_NOTE",
    "INTERVENTION_TOO_LONG",
    "ROLE_OVERRIDE_PROVIDER_NOT_SELECTED",
    "INVALID_COMMAND_TRANSFER",
    "COMMAND_TRANSFER_TOO_LARGE",
    "COMMAND_TRANSFER_SIZE_EXCEEDED",
    "COMMAND_TRANSFER_SIZE_MISMATCH",
    "COMMAND_TRANSFER_HASH_MISMATCH",
    "INVALID_EVENT_CURSOR",
    "INVALID_EVENT_LIMIT",
  ].includes(code)) return 400;
  if (code === "ENOENT") return 404;
  if (message.includes("ALREADY_EXISTS") || message.includes("ACTIVE") || message.includes("TARGET_CHANGED")) return 409;
  if (
    message.startsWith("INVALID_") ||
    message.startsWith("EMPTY_") ||
    message.startsWith("NO_VALID_") ||
    message.startsWith("DATA_ROOT_") ||
    message.startsWith("ARTIFACT_PATH_") ||
    message.startsWith("RELAY_HOST_") ||
    message.startsWith("RUN_CANNOT_") ||
    message.startsWith("RUN_NOT_") ||
    message.startsWith("TURN_NOT_")
  ) return 400;
  return 500;
}

function assertExtensionBridgePort(browserMode, port) {
  if (browserMode === "extension" && Number(port) !== EXTENSION_BRIDGE_PORT) {
    const error = new Error(`Extension mode requires port ${EXTENSION_BRIDGE_PORT}. Use CDP mode for a custom port.`);
    error.code = "EXTENSION_PORT_REQUIRED";
    throw error;
  }
}

function runtimeOptions(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || defaultRepoRoot);
  const store = options.store || new LocalWorkspaceStore({
    repoRoot,
    dataRoot: options.dataRoot || null,
    configFile: options.dataRootConfigFile || null,
  });
  const eventBus = options.eventBus || new EventBus();
  const runRegistry = options.runRegistry || new RunRegistry({ eventBus });
  const extensionRelay = options.extensionRelay || new ExtensionRelay();
  const adapters = options.adapters || createProviderAdapters({ urlOverrides: options.providerUrlOverrides || {} });
  const browserMode = options.browserMode ?? process.env.WEB_AGENTS_BROWSER_MODE ?? "cdp";
  const browserManager = options.browserManager || (browserMode === "extension"
    ? new ExtensionBrowserManager({ relay: extensionRelay, adapters })
    : new BrowserManager({
        mode: browserMode,
        profileDir: options.browserProfileDir || process.env.WEB_AGENTS_ROUNDTABLE_PROFILE_DIR || path.join(repoRoot, "browser-profiles", "roundtable"),
        cdpEndpoint: options.browserCdpEndpoint ?? process.env.WEB_AGENTS_BROWSER_CDP_ENDPOINT ?? "http://127.0.0.1:9223",
        adapters,
        headless: options.browserHeadless ?? process.env.WEB_AGENTS_BROWSER_HEADLESS === "1",
        channel: options.browserChannel ?? process.env.WEB_AGENTS_BROWSER_CHANNEL ?? "chrome",
      }));
  const worker = options.worker || (browserManager.mode === "extension"
    ? new ExtensionBrowserWorker({ manager: browserManager })
    : new BrowserWorker({ manager: browserManager, adapters }));
  const runtime = {
    repoRoot,
    providers: options.providers || PROVIDERS,
    store,
    eventBus,
    runRegistry,
    commandTransfers: options.commandTransfers || new CommandTransferRegistry(),
    extensionRelay,
    adapters,
    browserManager,
    worker,
    workspaceRegistry: options.workspaceRegistry || new WorkspaceRegistry({
      repoRoot,
      configFile: options.workspaceConfigFile || null,
      controllerProbe: options.workspaceControllerProbe || null,
    }),
    workspaceServices: new Map(),
    requireWorkspaceSelection: Boolean(options.requireWorkspaceSelection),
    localServicesProvider: options.localServicesProvider || null,
    explicitStore: Boolean(options.store || options.dataRoot),
    pageLeaseRegistry: options.pageLeaseRegistry || null,
    controlStore: options.controlStore || null,
    controlStores: new Map(),
    sqliteControlEnabled: options.sqliteControlEnabled ?? process.env.WEB_AGENTS_SQLITE_CONTROL !== "0",
    initializationPromise: null,
  };
  const services = createWorkspaceServices(runtime, store, {
    scheduler: options.scheduler,
    artifactWriter: options.artifactWriter,
  });
  runtime.activeWorkspace = services;
  runtime.store = services.store;
  runtime.scheduler = services.scheduler;
  runtime.artifactWriter = services.artifactWriter;
  runtime.handoffManager = services.handoffManager;
  runtime.controllerToolWorker = services.controllerToolWorker;
  runtime.permissionBroker = services.permissionBroker;
  runtime.transactionManager = services.transactionManager;
  return runtime;
}

function workspaceServiceKey(store) {
  return path.resolve(store.dataRoot || store.repoRoot);
}

function createWorkspaceServices(runtime, store, overrides = {}) {
  const key = workspaceServiceKey(store);
  const existing = runtime.workspaceServices?.get(key);
  if (existing) return existing;
  const workspaceRoot = store.workspaceRoot || runtime.repoRoot;
  const filesystemRoot = store.dataRoot || path.join(workspaceRoot, ".web-agents");
  const filesystemTools = createFilesystemTools({
    repoRoot: workspaceRoot,
    configFile: path.join(filesystemRoot, "config", "allowed-directories.txt"),
    permissionStoreDir: path.join(filesystemRoot, "permissions"),
    auditFile: path.join(filesystemRoot, "audit", "filesystem-writes.jsonl"),
  });
  const executeTool = (name, args, context = {}) => filesystemTools.call(name, args, {
    ...context,
    controllerCapability: CONTROLLER_TOOL_CAPABILITY,
  });
  const permissionBroker = new PermissionBroker({
    workspaceRoot,
    registry: defaultToolRegistry,
    audit: store,
    requestKind: "roundtable_permission_request",
  });
  const transactionManager = new TransactionManager({
    workspaceRoot,
    transactionRoot: path.join(store.dataRoot || workspaceRoot, "transactions"),
    registry: defaultToolRegistry,
    executeTool,
    audit: store,
  });
  const controllerToolWorker = new ControllerToolWorker({
    browserWorker: runtime.worker,
    permissionBroker,
    transactionManager,
    registry: defaultToolRegistry,
    store,
    executeTool,
    runRegistry: runtime.runRegistry,
  });
  const executionWorker = runtime.browserManager.mode === "extension"
    ? runtime.worker
    : new WorkbenchGateWorker({ store, browserWorker: runtime.worker, controllerToolWorker });
  const services = {
    store,
    permissionBroker,
    transactionManager,
    controllerToolWorker,
    executionWorker,
    scheduler: overrides.scheduler || new RoundtableScheduler({
      store,
      worker: executionWorker,
      eventBus: runtime.eventBus,
      runRegistry: runtime.runRegistry,
      strictReplyCommit: true,
    }),
    artifactWriter: overrides.artifactWriter || new ArtifactWriter({
      store,
      repoRoot: runtime.repoRoot,
      transactionManager,
    }),
    handoffManager: null,
    ready: transactionManager.initialize(),
  };
  services.handoffManager = new HandoffManager({
    store,
    browserManager: runtime.browserManager,
    worker: runtime.worker,
    eventBus: runtime.eventBus,
  });
  runtime.workspaceServices?.set(key, services);
  return services;
}

function activateWorkspace(runtime, entry) {
  const services = createWorkspaceServices(runtime, entry.store);
  runtime.activeWorkspace = services;
  runtime.store = services.store;
  runtime.scheduler = services.scheduler;
  runtime.artifactWriter = services.artifactWriter;
  runtime.handoffManager = services.handoffManager;
  runtime.controllerToolWorker = services.controllerToolWorker;
  runtime.permissionBroker = services.permissionBroker;
  runtime.transactionManager = services.transactionManager;
  return services;
}

function requireActiveWorkspace(runtime) {
  if (runtime.requireWorkspaceSelection && !runtime.workspaceRegistry.active && !runtime.explicitStore) {
    const error = new Error("WORKSPACE_REQUIRED");
    error.code = "WORKSPACE_REQUIRED";
    throw error;
  }
  return runtime.activeWorkspace;
}

async function reconcileInterruptedSessions(runtime) {
  const activeStatuses = new Set(["running", "paused", "waiting_recovery"]);
  const activeHandoffStatuses = new Set(["creating_thread", "sending_snapshot", "sending_delta"]);
  const summaries = await runtime.store.listSessions();
  for (const summary of summaries) {
    let session = await runtime.store.readSession(summary.id);
    if ((session.handoffs || []).some((handoff) => activeHandoffStatuses.has(handoff.status))) {
      session = await runtime.store.updateSession(session.id, (current) => {
        const interruptedAt = new Date().toISOString();
        for (const handoff of current.handoffs || []) {
          if (!activeHandoffStatuses.has(handoff.status)) continue;
          handoff.status = "failed";
          handoff.failedAt = interruptedAt;
          handoff.error = {
            code: "HANDOFF_INTERRUPTED",
            message: "The local service restarted before this handoff completed. The previous thread remains active.",
          };
        }
        current.updatedAt = interruptedAt;
        return current;
      });
    }
    let recovery = null;
    session = await runtime.store.updateSession(session.id, (current) => {
      const sessionStatus = current.runtime?.status;
      const runId = current.runtime?.activeRunId || randomUUID();
      if (!activeStatuses.has(sessionStatus) || runtime.runRegistry.get(runId)) return current;

      const activePlan = current.plans?.find((plan) => plan.id === current.runtime?.activePlanId);
      if (!activePlan) {
        current.runtime = {
          ...(current.runtime || {}),
          status: "failed",
          activePlanId: null,
          activeRunId: null,
          failedTurnId: null,
          error: { code: "ACTIVE_PLAN_NOT_FOUND", message: "The persisted active plan could not be restored." },
        };
        current.updatedAt = new Date().toISOString();
        return current;
      }
      const recoveredAt = new Date().toISOString();
      activePlan.status = "running";
      activePlan.recoveredAt = recoveredAt;
      activePlan.recoverySource = "service_restart";
      current.runtime = {
        ...(current.runtime || {}),
        status: sessionStatus === "paused" ? "paused" : "running",
        activePlanId: activePlan.id,
        activeRunId: runId,
      };
      current.updatedAt = recoveredAt;
      recovery = { sessionId: current.id, sessionStatus, runId, planId: activePlan.id };
      return current;
    });
    if (!recovery) continue;
    const controller = new AbortController();
    runtime.runRegistry.create({
      runId: recovery.runId,
      sessionId: recovery.sessionId,
      planId: recovery.planId,
      controller,
    });
    if (recovery.sessionStatus === "paused") runtime.runRegistry.pause(recovery.runId);
    startBackgroundRun(
      runtime,
      runtime,
      recovery.sessionId,
      recovery.planId,
      recovery.runId,
      controller,
      { resumePersisted: true },
    );
  }
}

async function configureControlStore(runtime, store) {
  await store.initialize();
  const dbPath = path.join(store.dataRoot, "roundtable.db");
  const key = path.resolve(dbPath);
  let controlStore = runtime.controlStores.get(key) || null;
  if (!controlStore) {
    controlStore = runtime.controlStore && runtime.controlStores.size === 0
      ? runtime.controlStore
      : new SqliteControlStore({ dbPath, enabled: runtime.sqliteControlEnabled });
    await controlStore.initialize();
    runtime.controlStores.set(key, controlStore);
  }
  store.setControlStore?.(controlStore);
  runtime.controlStore = controlStore;
  if (controlStore.available) {
    try {
      for (const summary of await store.listSessions()) {
        const session = await store.readSession(summary.id);
        controlStore.importExecutions(listExecutionIndex(session));
      }
    } catch (error) {
      controlStore.markDegraded(error);
    }
  }
  return controlStore;
}

async function configurePageLeaseRegistry(runtime, store) {
  const leaseFile = path.join(store.dataRoot, "browser", "page-leases.json");
  if (!runtime.pageLeaseRegistry || runtime.pageLeaseRegistry.filePath !== path.resolve(leaseFile)) {
    runtime.pageLeaseRegistry = new PageLeaseRegistry({ filePath: leaseFile, controlStore: runtime.controlStore });
  } else {
    runtime.pageLeaseRegistry.setControlStore?.(runtime.controlStore);
  }
  await runtime.pageLeaseRegistry.initialize();
  runtime.browserManager.setLeaseRegistry?.(runtime.pageLeaseRegistry);
  return runtime.pageLeaseRegistry;
}

async function initializeRuntime(runtime) {
  if (!runtime.initializationPromise) {
    runtime.initializationPromise = (async () => {
      await runtime.store.initialize();
      await configureControlStore(runtime, runtime.store);
      await configurePageLeaseRegistry(runtime, runtime.store);
      await runtime.workspaceRegistry.initialize();
      if (runtime.requireWorkspaceSelection && runtime.workspaceRegistry.active && !runtime.explicitStore) {
        activateWorkspace(runtime, runtime.workspaceRegistry.active);
        await runtime.store.initialize();
        await configureControlStore(runtime, runtime.store);
        await configurePageLeaseRegistry(runtime, runtime.store);
      }
      if (runtime.browserManager.mode === "cdp" && runtime.pageLeaseRegistry.list().some((lease) => !["FREE", "RELEASED", "INVALID"].includes(lease.state))) {
        await Promise.resolve(runtime.browserManager.connect?.()).catch(() => null);
      }
      await Promise.resolve(runtime.browserManager.reconcilePageLeases?.()).catch(() => {});
      for (const services of runtime.workspaceServices.values()) {
        await services.ready;
        await reconcileInterruptedSessions({ ...runtime, ...services });
      }
    })();
  }
  return runtime.initializationPromise;
}

async function getStore(options = {}) {
  if (options.store) {
    await options.store.initialize();
    return options.store;
  }
  const store = new LocalWorkspaceStore({
    repoRoot: options.repoRoot || defaultRepoRoot,
    dataRoot: options.dataRoot || null,
    configFile: options.dataRootConfigFile || null,
  });
  await store.initialize();
  return store;
}

export async function readSession(sessionId, options = {}) {
  return (await getStore(options)).readSession(sessionId);
}

export async function createSession(payload = {}, options = {}) {
  const store = await getStore(options);
  const providers = options.providers || PROVIDERS;
  const selectedIds = Array.isArray(payload.participants) && payload.participants.length
    ? uniqueProviderIds(payload.participants.map(String))
    : ["chatgpt", "deepseek", "doubao"];
  const participants = selectedIds
    .map((id) => getProvider(id, providers))
    .filter(Boolean)
    .map((provider) => ({
      ...provider,
      status: "not_open",
      joinedAt: new Date().toISOString(),
      joinPolicy: "sync_all",
      activeFromRound: 1,
    }));
  if (!participants.length) throw new Error("NO_VALID_PARTICIPANTS");
  const now = new Date().toISOString();
  const id = makeSessionId();
  const title = String(payload.title || "").trim();
  const threads = Object.fromEntries(participants.map((participant) => {
    const threadId = randomUUID();
    return [participant.id, {
      id: threadId,
      providerId: participant.id,
      threadKey: `${id}:${participant.id}:${threadId}`,
      status: "unprovisioned",
      createdAt: now,
      interactionCount: 0,
      lastDeliveredEventIndex: -1,
      deliveredChars: 0,
      capturedChars: 0,
    }];
  }));
  return store.createSession({
    id,
    title: title || "未命名圆桌",
    titleSource: title ? "explicit" : "default",
    renamedManually: false,
    objective: String(payload.objective || "").trim(),
    workspaceId: store.describe().workspaceId || null,
    workspaceRoot: store.workspaceRoot || null,
    createdAt: now,
    updatedAt: now,
    participants,
    hostId: participants[0].id,
    layout: createDefaultLayout(participants),
    settings: coerceSettings(payload.settings),
    events: [],
    plans: [],
    threads,
    context: {
      seatCursors: Object.fromEntries(participants.map((participant) => [participant.id, -1])),
      consensus: [],
      disagreements: [],
      evidence: [],
      requirements: [],
      summaries: [],
    },
    handoffs: [],
    transactions: [],
    pendingParticipants: [],
    participantRoles: {},
    pendingInterventions: [],
    checkpoints: [],
    actionJournal: [],
    unreadCount: 0,
    summary: null,
    runtime: { status: "idle", activePlanId: null, activeRunId: null },
    artifacts: [],
  });
}

function deriveSessionTitle(value) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "未命名圆桌";
  return normalized.length > 32 ? `${normalized.slice(0, 32)}...` : normalized;
}

function parseRollbackInstruction(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\/撤回(?:\s+(.+))?$/u);
  if (!match) return null;
  const target = String(match[1] || "").trim();
  return { target: !target || target === "上一个任务" ? "latest" : target };
}

async function executeRollbackInstruction(services, sessionId, instruction) {
  let session = await services.store.readSession(sessionId);
  const transactions = session.transactions || [];
  const transaction = instruction.target === "latest"
    ? [...transactions].reverse().find((candidate) => ["active", "committed", "failed", "rollback_conflicted"].includes(candidate.status))
    : transactions.find((candidate) => candidate.id === instruction.target);
  if (!transaction) throw new Error("TRANSACTION_NOT_FOUND");
  const rollback = await services.controllerToolWorker.rollback(transaction.id, {
    reason: "composer_command",
    sessionId,
    bindLegacySession: true,
  });
  const updated = services.controllerToolWorker.getTransaction(transaction.id);
  const now = new Date().toISOString();
  await services.store.updateSession(sessionId, (current) => {
    const index = (current.transactions || []).findIndex((candidate) => candidate.id === transaction.id);
    if (index >= 0) current.transactions[index] = updated;
    current.updatedAt = now;
    return current;
  });
  session = await services.store.appendEvents(sessionId, [{
    id: randomUUID(),
    type: "transaction_rollback",
    providerId: null,
    content: `已回撤事务 ${transaction.id}，状态：${rollback.status}`,
    commandId: null,
    round: null,
    metadata: { transactionId: transaction.id, rollback },
    createdAt: now,
  }]);
  return { session, transaction: updated, rollback };
}

async function nameSessionFromFirstMessage(store, session, text) {
  if (session.renamedManually || session.titleSource !== "default") return session;
  return store.updateSession(session.id, (current) => {
    if (current.renamedManually || current.titleSource !== "default") return current;
    current.title = deriveSessionTitle(text);
    current.titleSource = "first_message";
    current.updatedAt = new Date().toISOString();
    return current;
  });
}

export async function renameSession(sessionId, payload = {}, options = {}) {
  const store = await getStore(options);
  const title = String(payload.title || "").trim();
  if (!title) throw new Error("EMPTY_SESSION_TITLE");
  return store.updateSession(sessionId, (session) => {
    session.title = title.slice(0, 120);
    session.titleSource = "manual";
    session.renamedManually = true;
    session.updatedAt = new Date().toISOString();
    return session;
  });
}

async function provisionParticipantThread(runtime, services, sessionId, providerId, { refresh = false } = {}) {
  const initialSession = await services.store.readSession(sessionId);
  const thread = initialSession.threads?.[providerId];
  if (!thread) throw new Error("THREAD_NOT_FOUND");
  if (runtime.browserManager.mode === "extension") {
    return services.store.updateSession(sessionId, (session) => {
      if (!session.threads?.[providerId]) throw new Error("THREAD_NOT_FOUND");
      session.threads[providerId].status = "manual_binding";
      session.updatedAt = new Date().toISOString();
      return session;
    });
  }
  await services.store.updateSession(sessionId, (session) => {
    if (!session.threads?.[providerId]) throw new Error("THREAD_NOT_FOUND");
    session.threads[providerId].status = "opening";
    session.updatedAt = new Date().toISOString();
    return session;
  });
  let outcome;
  try {
    const opened = await (refresh && runtime.browserManager.reconnectProviderThread
      ? runtime.browserManager.reconnectProviderThread(providerId, {
          threadKey: thread.threadKey,
          sessionId,
          seatId: providerId,
          refresh: true,
        })
      : runtime.browserManager.createProviderThread(providerId, {
      threadKey: thread.threadKey,
      sessionId,
      seatId: providerId,
      }));
    outcome = {
      status: opened.status,
      url: opened.url || null,
      diagnostics: opened.diagnostics || null,
      openedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    outcome = {
      status: ["LOGIN_REQUIRED", "HUMAN_VERIFICATION_REQUIRED"].includes(error?.code)
        ? "waiting_user" : "waiting_browser",
      diagnostics: error?.details || error?.diagnostics || null,
      error: { code: error?.code || "THREAD_OPEN_FAILED", message: error?.message || String(error), details: error?.details || null },
    };
  }
  return services.store.updateSession(sessionId, (session) => {
    if (!session.threads?.[providerId]) throw new Error("THREAD_NOT_FOUND");
    Object.assign(session.threads[providerId], outcome);
    session.updatedAt = new Date().toISOString();
    return session;
  });
}

async function provisionSessionThreads(runtime, services, session) {
  // Each provisioning result updates the same persisted session. Keep these
  // writes ordered so a stale read cannot overwrite another seat's outcome.
  for (const participant of session.participants) {
    await provisionParticipantThread(runtime, services, session.id, participant.id);
  }
  return services.store.readSession(session.id);
}

export async function addSessionParticipant(sessionId, payload = {}, options = {}) {
  const store = await getStore(options);
  const providers = options.providers || PROVIDERS;
  const providerId = String(payload.providerId || "");
  const provider = getProvider(providerId, providers);
  if (!provider) throw new Error("PROVIDER_NOT_FOUND");
  const joinPolicy = payload.joinPolicy === "from_now" ? "from_now" : "sync_all";
  return store.updateSession(sessionId, (session) => {
    if (session.participants.some((participant) => participant.id === providerId)) throw new Error("PARTICIPANT_ALREADY_EXISTS");
    const activePlan = session.plans?.find((plan) => plan.id === session.runtime?.activePlanId);
    const currentRound = Math.max(0, ...((activePlan?.turns || []).filter((turn) => turn.status === "completed").map((turn) => turn.round || 0)));
    const activeFromRound = activePlan ? currentRound + 1 : 1;
    const now = new Date().toISOString();
    session.participants.push({ ...provider, status: "not_open", joinedAt: now, joinPolicy, activeFromRound });
    const threadId = randomUUID();
    session.threads = { ...(session.threads || {}), [providerId]: {
      id: threadId,
      providerId,
      threadKey: `${sessionId}:${providerId}:${threadId}`,
      status: "unprovisioned",
      createdAt: now,
      interactionCount: 0,
      lastDeliveredEventIndex: joinPolicy === "from_now" ? session.events.length - 1 : -1,
      deliveredChars: 0,
      capturedChars: 0,
    } };
    session.context = {
      ...(session.context || {}),
      seatCursors: {
        ...(session.context?.seatCursors || {}),
        [providerId]: joinPolicy === "from_now" ? session.events.length - 1 : -1,
      },
    };
    session.pendingParticipants = activePlan
      ? [...(session.pendingParticipants || []), { providerId, activeFromRound, joinedAt: now }]
      : session.pendingParticipants || [];
    session.layout = normalizeLayout(session.participants, session.layout, createDefaultLayout(session.participants));
    session.updatedAt = now;
    return session;
  });
}

export async function removeSessionParticipant(sessionId, payload = {}, options = {}) {
  const store = await getStore(options);
  const providerId = String(payload.providerId || "");
  return store.updateSession(sessionId, (session) => {
    if (!session.participants.some((participant) => participant.id === providerId)) throw new Error("PARTICIPANT_NOT_FOUND");
    if (session.participants.length === 1) throw new Error("LAST_PARTICIPANT_REQUIRED");
    session.participants = session.participants.filter((participant) => participant.id !== providerId);
    session.layout = normalizeLayout(session.participants, session.layout);
    session.hostId = session.hostId === providerId ? null : session.hostId;
    session.pendingParticipants = (session.pendingParticipants || []).filter((participant) => participant.providerId !== providerId);
    if (session.threads?.[providerId]) session.threads[providerId].status = "left";
    session.updatedAt = new Date().toISOString();
    return session;
  });
}

export async function appendSessionEvent(sessionId, payload = {}, options = {}) {
  const store = await getStore(options);
  const content = String(payload.content || "").trim();
  if (!content) throw new Error("EMPTY_EVENT_CONTENT");
  const event = {
    id: randomUUID(),
    type: String(payload.type || "note"),
    providerId: payload.providerId ? String(payload.providerId) : null,
    content,
    commandId: payload.commandId ? String(payload.commandId) : null,
    round: payload.round ? Number(payload.round) : null,
    metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
    createdAt: new Date().toISOString(),
  };
  const session = await store.appendEvents(sessionId, [event]);
  return { session, event };
}

export async function executeRoundtableCommand(sessionId, payload = {}, options = {}) {
  const store = await getStore(options);
  const scheduler = options.scheduler || new RoundtableScheduler({
    store,
    worker: options.worker || null,
    eventBus: options.eventBus || null,
    runRegistry: options.runRegistry || null,
  });
  return scheduler.executeCommand(sessionId, payload, options);
}

export async function updateSessionSettings(sessionId, payload = {}, options = {}) {
  const store = await getStore(options);
  return store.updateSession(sessionId, (session) => {
    session.settings = coerceSettings({ ...(session.settings || {}), ...(payload.settings || payload) });
    session.updatedAt = new Date().toISOString();
    return session;
  });
}

export async function updateParticipantOrder(sessionId, payload = {}, options = {}) {
  const store = await getStore(options);
  const order = uniqueProviderIds(Array.isArray(payload.order) ? payload.order.map(String) : []);
  return store.updateSession(sessionId, (session) => {
    const currentIds = session.participants.map((participant) => participant.id);
    const sameParticipants = order.length === currentIds.length && currentIds.every((providerId) => order.includes(providerId));
    if (!sameParticipants) throw new Error("INVALID_PARTICIPANT_ORDER");
    const byId = new Map(session.participants.map((participant) => [participant.id, participant]));
    session.participants = order.map((providerId) => byId.get(providerId));
    session.hostId = order[0];
    session.updatedAt = new Date().toISOString();
    return session;
  });
}

export async function updateParticipantLayout(sessionId, payload = {}, options = {}) {
  const store = await getStore(options);
  const requestedHostId = payload.hostId === null || payload.hostId === undefined ? null : String(payload.hostId);
  return store.updateSession(sessionId, (session) => {
    const currentIds = session.participants.map((participant) => participant.id);
    const requestedOrder = uniqueProviderIds(Array.isArray(payload.order) ? payload.order.map(String) : currentIds);
    const sameParticipants = requestedOrder.length === currentIds.length && currentIds.every((providerId) => requestedOrder.includes(providerId));
    if (!sameParticipants) throw new Error("INVALID_PARTICIPANT_ORDER");
    if (requestedHostId && !currentIds.includes(requestedHostId)) throw new Error("INVALID_HOST_ID");
    const order = requestedHostId
      ? [requestedHostId, ...requestedOrder.filter((providerId) => providerId !== requestedHostId)]
      : requestedOrder;
    const byId = new Map(session.participants.map((participant) => [participant.id, participant]));
    session.participants = order.map((providerId) => byId.get(providerId));
    session.layout = normalizeLayout(session.participants, payload.layout, session.layout);
    session.hostId = requestedHostId;
    session.updatedAt = new Date().toISOString();
    return session;
  });
}

export async function writeSummary(sessionId, payload = {}, options = {}) {
  const store = await getStore(options);
  const session = await store.readSession(sessionId);
  const summary = String(payload.summary || "").trim();
  if (!summary) throw new Error("EMPTY_SUMMARY");
  const now = new Date().toISOString();
  const content = [
    `# ${session.title}`,
    "",
    `- Session: ${session.id}`,
    `- Created: ${session.createdAt}`,
    `- Updated: ${now}`,
    "",
    "## Objective",
    "",
    session.objective || "未填写",
    "",
    "## Summary",
    "",
    summary,
    "",
  ].join("\n");
  const filePath = await store.writeSummaryFile(sessionId, content);
  const saved = await store.updateSession(sessionId, (current) => {
    current.summary = { text: summary, filePath, updatedAt: now };
    current.updatedAt = now;
    return current;
  });
  return { session: saved, filePath };
}

async function serveStatic(request, response, publicDir) {
  const url = new URL(request.url, "http://127.0.0.1");
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const relativePath = requestedPath.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relativePath);
  const resolvedPublic = path.resolve(publicDir);
  if (filePath !== resolvedPublic && !filePath.startsWith(`${resolvedPublic}${path.sep}`)) {
    return sendText(response, 403, "Forbidden");
  }
  try {
    const content = await fs.readFile(filePath);
    const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    response.end(content);
  } catch {
    sendText(response, 404, "Not found");
  }
}

async function serveVendor(request, response) {
  const filePath = VENDOR_FILES.get(new URL(request.url, "http://127.0.0.1").pathname);
  if (!filePath) return sendText(response, 404, "Not found");
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    response.end(content);
  } catch {
    sendText(response, 404, "Not found");
  }
}

function serveEvents(request, response, runtime, url) {
  const sessionId = url.searchParams.get("sessionId");
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 1500\n\n");
  const send = (event) => {
    response.write(`id: ${event.id}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  send({
    id: randomUUID(),
    type: "runtime.connected",
    at: new Date().toISOString(),
    sessionId,
    storage: runtime.activeWorkspace?.store.describe() || null,
    workspace: runtime.workspaceRegistry.describe(),
    browser: runtime.browserManager.status(),
  });
  const unsubscribe = runtime.eventBus.subscribe(send, { sessionId });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
  heartbeat.unref?.();
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function persistRunState(runtime, services, run) {
  return services.store.updateSession(run.sessionId, (session) => {
    session.runtime = {
      ...(session.runtime || {}),
      status: run.status,
      activeRunId: ["completed", "failed", "cancelled"].includes(run.status) ? null : run.runId,
      activePlanId: ["completed", "failed", "cancelled"].includes(run.status) ? null : run.planId,
      failedTurnId: run.failedTurnId,
      error: run.error,
    };
    session.updatedAt = new Date().toISOString();
    return session;
  });
}

function startBackgroundRun(runtime, services, sessionId, planId, runId, controller, executionOptions = {}) {
  queueMicrotask(async () => {
    try {
      const result = await services.scheduler.executePreparedPlan(sessionId, planId, {
        runId,
        signal: controller.signal,
        ...executionOptions,
      });
      if (result?.awaitingContinuation) runtime.runRegistry.awaitContinuation(runId);
      else runtime.runRegistry.complete(runId);
    } catch (error) {
      runtime.runRegistry.fail(runId, error);
    }
  });
}

async function handleStorageRoute(request, response, runtime, parts) {
  let services = runtime.activeWorkspace;
  if (request.method === "GET" && parts.length === 2) {
    if (runtime.requireWorkspaceSelection && !runtime.workspaceRegistry.active && !runtime.explicitStore) {
      return sendJson(response, 200, { ok: true, storage: null, workspaceRequired: true });
    }
    services = requireActiveWorkspace(runtime);
    return sendJson(response, 200, { ok: true, storage: services.store.describe() });
  }
  if (request.method !== "POST" || parts.length !== 3) return false;
  const payload = await readJson(request);
  if (parts[2] === "root") {
    if (runtime.requireWorkspaceSelection && !runtime.explicitStore) {
      const entry = await runtime.workspaceRegistry.select(payload.path);
      const selected = activateWorkspace(runtime, entry);
      await selected.ready;
      await selected.store.initialize();
      await configureControlStore(runtime, selected.store);
      await configurePageLeaseRegistry(runtime, selected.store);
      await reconcileInterruptedSessions({ ...runtime, ...selected });
      const storage = selected.store.describe();
      runtime.eventBus.emit({ type: "workspace.selected", workspace: entry.descriptor, storage });
      return sendJson(response, 200, { ok: true, storage, workspace: entry.descriptor });
    }
    services = requireActiveWorkspace(runtime);
    const storage = await services.store.setDataRoot(payload.path);
    await configureControlStore(runtime, services.store);
    await configurePageLeaseRegistry(runtime, services.store);
    await reconcileInterruptedSessions({ ...runtime, ...services });
    runtime.eventBus.emit({ type: "storage.root_changed", storage });
    return sendJson(response, 200, { ok: true, storage });
  }
  if (parts[2] === "import") {
    services = requireActiveWorkspace(runtime);
    const result = await services.store.importFromPath(payload.path);
    await configureControlStore(runtime, services.store);
    await reconcileInterruptedSessions({ ...runtime, ...services });
    runtime.eventBus.emit({ type: "storage.imported", result });
    return sendJson(response, 200, { ok: true, ...result });
  }
  if (parts[2] === "reindex") {
    services = requireActiveWorkspace(runtime);
    const result = await services.store.reindex();
    await configureControlStore(runtime, services.store);
    await reconcileInterruptedSessions({ ...runtime, ...services });
    runtime.eventBus.emit({ type: "storage.reindexed", count: result.sessions.length });
    return sendJson(response, 200, { ok: true, ...result });
  }
  return false;
}

async function handleWorkspaceRoute(request, response, runtime, parts) {
  if (request.method === "GET" && parts.length === 2) {
    return sendJson(response, 200, { ok: true, ...runtime.workspaceRegistry.describe() });
  }
  if (request.method === "POST" && parts.length === 3 && parts[2] === "select") {
    const payload = await readJson(request);
    const entry = await runtime.workspaceRegistry.select(payload.path);
    const services = activateWorkspace(runtime, entry);
    await services.ready;
    await reconcileInterruptedSessions({ ...runtime, ...services });
    runtime.eventBus.emit({
      type: "workspace.selected",
      workspace: entry.descriptor,
      storage: services.store.describe(),
    });
    return sendJson(response, 200, {
      ok: true,
      workspace: entry.descriptor,
      storage: services.store.describe(),
      sessions: await services.store.listSessions(),
    });
  }
  return false;
}

async function handlePermissionRoute(request, response, runtime, parts) {
  const services = requireActiveWorkspace(runtime);
  if (request.method === "GET" && parts.length === 3 && parts[2] === "pending") {
    return sendJson(response, 200, { ok: true, requests: services.controllerToolWorker.listPermissionRequests() });
  }
  if (request.method === "POST" && parts.length === 4) {
    const requestId = parts[2];
    const decision = parts[3] === "allow-once" ? "allow_once" : parts[3] === "allow-task" ? "allow_task" : parts[3];
    const result = await services.controllerToolWorker.resolvePermission(requestId, decision);
    runtime.eventBus.emit({
      type: decision === "reject" ? "permission.rejected" : "permission.approved",
      sessionId: result.request?.sessionId || null,
      requestId,
      decision,
    });
    return sendJson(response, 200, { ok: true, ...result });
  }
  return false;
}

async function handleRunAction(request, response, runtime, services, sessionId, runId, action) {
  if (request.method !== "POST") return false;
  const run = runtime.runRegistry.get(runId);
  if (!run || run.sessionId !== sessionId) throw new Error("RUN_NOT_FOUND");
  const payload = await readJson(request);
  const turnId = String(payload.turnId || "");
  const decisionKey = String(payload.decisionId || `${action}:${turnId}:${action === "manual" ? String(payload.content || "").trim() : ""}`);
  let updated;
  if (action === "pause") updated = runtime.runRegistry.pause(runId);
  else if (action === "resume") updated = runtime.runRegistry.resume(runId);
  else if (action === "cancel") updated = runtime.runRegistry.cancel(runId, payload.reason || "用户终止");
  else if (action === "retry") updated = runtime.runRegistry.retry(runId, turnId, { decisionKey });
  else if (action === "skip") updated = runtime.runRegistry.skip(runId, turnId, decisionKey);
  else if (action === "manual") updated = runtime.runRegistry.manual(runId, turnId, payload.content, decisionKey);
  else return false;
  const schedulerOwnedRecovery = ["retry", "skip", "manual"].includes(action);
  if (schedulerOwnedRecovery) return sendJson(response, 200, { ok: true, run: updated });
  const session = await persistRunState(runtime, services, updated);
  return sendJson(response, 200, { ok: true, run: updated, session });
}

function parseEventCursor(url) {
  const afterRaw = url.searchParams.get("after");
  const lastEventId = url.searchParams.get("lastEventId") || null;
  const limitRaw = url.searchParams.get("limit");
  let after = null;
  if (afterRaw !== null && afterRaw !== "") {
    after = Number(afterRaw);
    if (!Number.isInteger(after) || after < 0) {
      throw Object.assign(new Error("after must be a non-negative integer"), { code: "INVALID_EVENT_CURSOR" });
    }
  }
  let limit = 200;
  if (limitRaw !== null && limitRaw !== "") {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw Object.assign(new Error("limit must be an integer between 1 and 1000"), { code: "INVALID_EVENT_LIMIT" });
    }
  }
  return { after, lastEventId, limit };
}

async function paginateSessionEvents(sessionId, url, { store }) {
  const { after, lastEventId, limit } = parseEventCursor(url);
  const session = await store.readSession(sessionId);
  const events = Array.isArray(session.events) ? session.events : [];
  const total = events.length;
  let fromIndex = 0;
  let resyncRequired = false;
  if (after !== null && after > total) {
    resyncRequired = true;
  } else if (lastEventId) {
    const lastIndex = events.findIndex((event) => event && event.id === lastEventId);
    if (lastIndex === -1) {
      resyncRequired = true;
    } else if (after === null || lastIndex !== after - 1) {
      resyncRequired = true;
    }
  }
  if (!resyncRequired && after !== null) fromIndex = after;
  const slice = events.slice(fromIndex, fromIndex + limit);
  return {
    events: slice,
    fromIndex,
    nextIndex: fromIndex + slice.length,
    total,
    resyncRequired,
  };
}

async function dispatchSessionCommand(runtime, services, sessionId, payload) {
  const { store, scheduler } = services;
  let current = await store.readSession(sessionId);
  const rollbackInstruction = parseRollbackInstruction(payload.text);
  if (rollbackInstruction) {
    current = await nameSessionFromFirstMessage(store, current, payload.text);
    const result = await executeRollbackInstruction(services, sessionId, rollbackInstruction);
    runtime.eventBus.emit({ type: "transaction.rolled_back", sessionId, transaction: result.transaction });
    return { status: 200, body: { ok: true, ...result, plan: null, run: null } };
  }
  const settings = coerceSettings({ ...(current.settings || {}), ...(payload.settings || {}) });
  const parsedForTitle = parseRoundtableCommand(payload, current, settings);
  current = await nameSessionFromFirstMessage(store, current, parsedForTitle.instruction);
  if (settings.mode !== "mock") {
    const runtimeExecutionMode = runtime.browserManager.mode === "extension" ? "extension" : "playwright";
    if (settings.mode !== runtimeExecutionMode) {
      const error = new Error(`The session execution mode ${settings.mode} does not match the active ${runtimeExecutionMode} browser runtime.`);
      error.code = "BROWSER_MODE_MISMATCH";
      throw error;
    }
    const runId = randomUUID();
    const prepared = await scheduler.prepareCommand(sessionId, payload, { runId });
    const controller = new AbortController();
    const run = runtime.runRegistry.create({ runId, sessionId, planId: prepared.plan.id, controller });
    startBackgroundRun(runtime, services, sessionId, prepared.plan.id, runId, controller);
    return { status: 202, body: { ok: true, ...prepared, run } };
  }
  const result = await scheduler.executeCommand(sessionId, payload);
  return { status: 200, body: { ok: true, ...result, run: null } };
}

async function handleSessionRoute(request, response, runtime, url, parts) {
  const services = requireActiveWorkspace(runtime);
  const { store, scheduler, artifactWriter, handoffManager, controllerToolWorker } = services;
  if (parts.length === 2) {
    if (request.method === "GET") return sendJson(response, 200, { ok: true, sessions: await store.listSessions() });
    if (request.method === "POST") {
      const payload = await readJson(request);
      let session = await createSession(payload, { store, providers: runtime.providers });
      if (payload.openThreads !== false) session = await provisionSessionThreads(runtime, services, session);
      runtime.eventBus.emit({ type: "session.created", sessionId: session.id, session });
      return sendJson(response, 201, { ok: true, session });
    }
    return false;
  }
  const sessionId = parts[2];
  if (parts.length === 3 && request.method === "GET") {
    const session = await store.readSession(sessionId);
    if (url.searchParams.get("events") === "none") {
      const totalEvents = Array.isArray(session.events) ? session.events.length : 0;
      return sendJson(response, 200, { ok: true, session: { ...session, events: [] }, eventsOmitted: true, totalEvents });
    }
    return sendJson(response, 200, { ok: true, session });
  }
  const action = parts[3];
  if (parts.length === 4) {
    if (request.method === "GET" && action === "prompt") {
      const session = await store.readSession(sessionId);
      const providerId = url.searchParams.get("provider") || session.participants[0]?.id;
      return sendJson(response, 200, { ok: true, prompt: buildPrompt(session, providerId), providerId });
    }
    if (request.method === "POST" && action === "events") {
      const result = await appendSessionEvent(sessionId, await readJson(request), { store });
      runtime.eventBus.emit({ type: "session.event_appended", sessionId, event: result.event });
      return sendJson(response, 200, { ok: true, ...result });
    }
    if (request.method === "GET" && action === "events") {
      return sendJson(response, 200, { ok: true, ...(await paginateSessionEvents(sessionId, url, { store })) });
    }
    if (request.method === "POST" && action === "command-transfers") {
      const payload = await readJson(request);
      const registration = runtime.commandTransfers.begin(sessionId, payload);
      return sendJson(response, 201, { ok: true, ...registration });
    }
    if (request.method === "POST" && action === "commands") {
      const payload = await readJson(request);
      const dispatched = await dispatchSessionCommand(runtime, services, sessionId, payload);
      return sendJson(response, dispatched.status, dispatched.body);
    }
    if (request.method === "POST" && action === "participant-role") {
      const payload = await readJson(request);
      let role = "";
      const session = await store.updateSession(sessionId, (current) => {
        role = setDefaultSeatRole(current, payload);
        current.updatedAt = new Date().toISOString();
        return current;
      });
      runtime.eventBus.emit({
        type: "participant.role_updated",
        sessionId,
        providerId: String(payload.providerId || ""),
        role,
        session,
      });
      return sendJson(response, 200, { ok: true, providerId: String(payload.providerId || ""), role, session });
    }
    if (request.method === "POST" && action === "interventions") {
      const payload = await readJson(request);
      let intervention = null;
      const session = await store.updateSession(sessionId, (current) => {
        const planId = String(payload.planId || current.runtime?.activePlanId || "");
        const plan = current.plans?.find((candidate) => candidate.id === planId);
        if (!plan) throw Object.assign(new Error("PLAN_NOT_FOUND"), { code: "PLAN_NOT_FOUND" });
        if (plan.conversationMode !== "discussion" || !["planned", "running", "waiting_recovery", "awaiting_continuation"].includes(plan.status) || plan.closureTurnId) {
          throw Object.assign(new Error("DISCUSSION_PLAN_NOT_ACTIVE"), { code: "DISCUSSION_PLAN_NOT_ACTIVE" });
        }
        intervention = queueIntervention(current, {
          id: randomUUID(),
          planId,
          content: payload.content,
        });
        current.updatedAt = intervention.updatedAt;
        return current;
      });
      runtime.eventBus.emit({ type: "intervention.queued", sessionId, planId: intervention.planId, intervention, session });
      return sendJson(response, 201, { ok: true, intervention, session });
    }
    if (request.method === "POST" && action === "settings") {
      const session = await updateSessionSettings(sessionId, await readJson(request), { store });
      runtime.eventBus.emit({ type: "session.settings_updated", sessionId, session });
      return sendJson(response, 200, { ok: true, session });
    }
    if (request.method === "POST" && action === "participants-order") {
      const session = await updateParticipantOrder(sessionId, await readJson(request), { store });
      runtime.eventBus.emit({ type: "session.layout_updated", sessionId, session });
      return sendJson(response, 200, { ok: true, session });
    }
    if (request.method === "POST" && action === "participant-layout") {
      const session = await updateParticipantLayout(sessionId, await readJson(request), { store });
      runtime.eventBus.emit({ type: "session.layout_updated", sessionId, session });
      return sendJson(response, 200, { ok: true, session });
    }
    if (request.method === "POST" && action === "summary") {
      const result = await writeSummary(sessionId, await readJson(request), { store });
      runtime.eventBus.emit({ type: "session.summary_written", sessionId, filePath: result.filePath });
      return sendJson(response, 200, { ok: true, ...result });
    }
    if (request.method === "POST" && action === "export") {
      const payload = await readJson(request);
      const result = await store.exportSession(sessionId, payload.path || null);
      return sendJson(response, 200, { ok: true, ...result });
    }
    if (request.method === "GET" && action === "audit") {
      return sendJson(response, 200, { ok: true, audit: await store.listAudit({ sessionId }) });
    }
    if (request.method === "GET" && action === "executions") {
      const session = await store.readSession(sessionId);
      const jsonExecutions = listExecutionIndex(session);
      const sqliteExecutions = runtime.controlStore?.available
        ? runtime.controlStore.listExecutions({ sessionId })
        : [];
      const executions = [...new Map([
        ...jsonExecutions.map((record) => [record.executionId, record]),
        ...sqliteExecutions.map((record) => [record.executionId, record]),
      ]).values()];
      return sendJson(response, 200, {
        ok: true,
        executions,
        pending: executions.filter((record) =>
          ["waiting_recovery", "failed"].includes(record.status)
            || record.sendState === "SEND_UNKNOWN"
            || record.executionPhase === "send_unknown"
        ),
        source: runtime.controlStore?.available ? "sqlite_primary" : "json",
        runtime: session.runtime || {},
      });
    }
    if (action === "artifacts" && request.method === "GET") {
      return sendJson(response, 200, { ok: true, artifacts: await artifactWriter.list(sessionId) });
    }
    if (action === "artifacts" && request.method === "POST") {
      const result = await artifactWriter.write(sessionId, await readJson(request));
      runtime.eventBus.emit({ type: "artifact.written", sessionId, artifact: result.artifact });
      return sendJson(response, 201, { ok: true, ...result, session: await store.readSession(sessionId) });
    }
    if (request.method === "POST" && action === "rename") {
      const session = await renameSession(sessionId, await readJson(request), { store });
      runtime.eventBus.emit({ type: "session.renamed", sessionId, session });
      return sendJson(response, 200, { ok: true, session });
    }
    if (request.method === "POST" && action === "participants") {
      const payload = await readJson(request);
      let session = await addSessionParticipant(sessionId, payload, { store, providers: runtime.providers });
      session = await provisionParticipantThread(runtime, services, sessionId, String(payload.providerId));
      runtime.eventBus.emit({ type: "session.participant_joined", sessionId, providerId: payload.providerId, session });
      return sendJson(response, 201, { ok: true, session });
    }
    if (request.method === "POST" && action === "participants-reconnect") {
      const payload = await readJson(request);
      const providerId = String(payload.providerId || "");
      const session = await provisionParticipantThread(runtime, services, sessionId, providerId, { refresh: true });
      runtime.eventBus.emit({ type: "session.participant_reconnected", sessionId, providerId, session });
      return sendJson(response, 200, { ok: true, session });
    }
    if (request.method === "POST" && action === "participants-remove") {
      const payload = await readJson(request);
      const session = await removeSessionParticipant(sessionId, payload, { store });
      runtime.eventBus.emit({ type: "session.participant_left", sessionId, providerId: payload.providerId, session });
      return sendJson(response, 200, { ok: true, session });
    }
    if (request.method === "POST" && action === "handoffs") {
      const payload = await readJson(request);
      const handoff = await handoffManager.preview(sessionId, String(payload.providerId || ""));
      return sendJson(response, 201, { ok: true, handoff });
    }
  }
  if (action === "interventions" && parts.length === 5 && ["PATCH", "DELETE"].includes(request.method)) {
    const interventionId = parts[4];
    const payload = request.method === "PATCH" ? await readJson(request) : {};
    let intervention = null;
    const session = await store.updateSession(sessionId, (current) => {
      intervention = request.method === "PATCH"
        ? updateIntervention(current, { id: interventionId, content: payload.content })
        : removeIntervention(current, { id: interventionId });
      current.updatedAt = new Date().toISOString();
      return current;
    });
    const eventType = request.method === "PATCH" ? "intervention.updated" : "intervention.removed";
    runtime.eventBus.emit({ type: eventType, sessionId, planId: intervention.planId, intervention, session });
    return sendJson(response, 200, { ok: true, intervention, session });
  }
  if (action === "plans" && parts.length === 6 && parts[5] === "continue" && request.method === "POST") {
    const planId = parts[4];
    const runId = randomUUID();
    const controller = new AbortController();
    let plan = null;
    const session = await store.updateSession(sessionId, (current) => {
      plan = current.plans?.find((candidate) => candidate.id === planId);
      if (!plan) throw Object.assign(new Error("PLAN_NOT_FOUND"), { code: "PLAN_NOT_FOUND" });
      if (plan.conversationMode !== "discussion" || plan.status !== "awaiting_continuation") {
        throw Object.assign(new Error("PLAN_NOT_AWAITING_CONTINUATION"), { code: "PLAN_NOT_AWAITING_CONTINUATION" });
      }
      if (Number(plan.maxCycles || plan.rounds || 0) >= 10) {
        throw Object.assign(new Error("DISCUSSION_CYCLE_LIMIT_REACHED"), { code: "DISCUSSION_CYCLE_LIMIT_REACHED" });
      }
      plan.maxCycles = Number(plan.maxCycles || plan.rounds || 0) + 1;
      plan.rounds = plan.maxCycles;
      plan.status = "running";
      plan.error = null;
      current.runtime = {
        ...(current.runtime || {}),
        status: "running",
        activePlanId: planId,
        activeRunId: runId,
        failedTurnId: null,
        error: null,
      };
      current.updatedAt = new Date().toISOString();
      return current;
    });
    const run = runtime.runRegistry.create({ runId, sessionId, planId, controller });
    startBackgroundRun(runtime, services, sessionId, planId, runId, controller, { resumePersisted: true });
    return sendJson(response, 202, { ok: true, session, plan, run });
  }
  if (action === "command-transfers" && parts.length === 5) {
    const transferId = parts[4];
    if (request.method === "GET") {
      return sendJson(response, 200, { ok: true, ...runtime.commandTransfers.status(sessionId, transferId) });
    }
    if (request.method === "DELETE") {
      return sendJson(response, 200, { ok: true, ...runtime.commandTransfers.cancel(sessionId, transferId) });
    }
    return false;
  }
  if (action === "command-transfers" && parts.length === 6 && ["chunks", "commit"].includes(parts[5]) && request.method === "POST") {
    const transferId = parts[4];
    if (parts[5] === "chunks") {
      const payload = await readJson(request);
      const result = runtime.commandTransfers.append(sessionId, transferId, payload);
      return sendJson(response, 200, { ok: true, ...result });
    }
    await readJson(request);
    const assembled = runtime.commandTransfers.commit(sessionId, transferId);
    runtime.eventBus.emit({ type: "session.command_transfer_committed", sessionId, transferId, bytes: assembled.bytes });
    const dispatched = await dispatchSessionCommand(runtime, services, sessionId, { ...(assembled.command || {}), text: assembled.text });
    return sendJson(response, dispatched.status, dispatched.body);
  }
  if (action === "context" && parts.length === 5 && parts[4] === "compression" && request.method === "GET") {
    const session = await store.readSession(sessionId);
    const active = getActiveCompression(session);
    if (!active) throw Object.assign(new Error("COMPRESSION_NOT_FOUND"), { code: "COMPRESSION_NOT_FOUND" });
    return sendJson(response, 200, {
      ok: true,
      compression: session.context.compression,
      active,
      estimate: active.estimate || null,
    });
  }
  if (action === "context" && parts.length === 6 && parts[4] === "compression" && parts[5] === "revise" && request.method === "POST") {
    const payload = await readJson(request);
    let revised;
    const session = await store.updateSession(sessionId, (current) => {
      revised = reviseSessionCompression(current, payload);
      current.updatedAt = new Date().toISOString();
      return current;
    });
    await store.appendAudit({
      kind: "compression_revision",
      sessionId,
      revision: revised.revision,
      reason: revised.reason,
      coveredThroughEventIndex: revised.coveredThroughEventIndex,
    });
    runtime.eventBus.emit({ type: "session.compression_revised", sessionId, revision: revised.revision });
    return sendJson(response, 200, { ok: true, compression: session.context.compression, active: revised, session });
  }
  if (action === "context" && parts.length === 6 && parts[4] === "compression" && parts[5] === "diff" && request.method === "GET") {
    const session = await store.readSession(sessionId);
    const diff = diffCompressionRevisions(session, {
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
    });
    return sendJson(response, 200, { ok: true, diff });
  }
  if (action === "context" && parts.length === 6 && parts[4] === "compression" && parts[5] === "rollback" && request.method === "POST") {
    const payload = await readJson(request);
    let rolledBack;
    const session = await store.updateSession(sessionId, (current) => {
      rolledBack = rollbackCompressionFields(current, payload);
      current.updatedAt = new Date().toISOString();
      return current;
    });
    await store.appendAudit({
      kind: "compression_rollback",
      sessionId,
      revision: rolledBack.revision,
      targetRevision: rolledBack.rollback.targetRevision,
      fields: rolledBack.rollback.fields,
    });
    runtime.eventBus.emit({ type: "session.compression_rolled_back", sessionId, revision: rolledBack.revision });
    return sendJson(response, 200, { ok: true, compression: session.context.compression, active: rolledBack });
  }
  if (action === "context" && parts.length === 6 && parts[4] === "compression" && parts[5] === "annotate" && request.method === "POST") {
    const payload = await readJson(request);
    let annotated;
    const session = await store.updateSession(sessionId, (current) => {
      annotated = annotateCompressionRevision(current, payload);
      current.updatedAt = new Date().toISOString();
      return current;
    });
    await store.appendAudit({
      kind: "compression_annotation",
      sessionId,
      revision: annotated.revision.revision,
      annotationId: annotated.annotation.id,
    });
    runtime.eventBus.emit({ type: "session.compression_annotated", sessionId, revision: annotated.revision.revision });
    return sendJson(response, 200, { ok: true, revision: annotated.revision, annotation: annotated.annotation });
  }
  if (action === "runs" && parts.length === 6) {
    return handleRunAction(request, response, runtime, services, sessionId, parts[4], parts[5]);
  }
  if (action === "artifacts" && parts.length === 6 && parts[5] === "rollback" && request.method === "POST") {
    const result = await artifactWriter.rollback(sessionId, parts[4]);
    runtime.eventBus.emit({ type: "artifact.rolled_back", sessionId, artifact: result.artifact });
    return sendJson(response, 200, { ok: true, ...result, session: await store.readSession(sessionId) });
  }
  if (action === "handoffs" && parts.length === 6 && parts[5] === "confirm" && request.method === "POST") {
    const result = await handoffManager.confirm(sessionId, parts[4], await readJson(request));
    return sendJson(response, 200, { ok: true, ...result });
  }
  if (action === "transactions" && parts.length === 6 && parts[5] === "rollback" && request.method === "POST") {
    const transactionId = parts[4];
    const session = await store.readSession(sessionId);
    const hasVerifiedLegacyReference = (session.transactions || []).some((candidate) => candidate.id === transactionId)
      || (session.artifacts || []).some((candidate) => candidate.transactionId === transactionId);
    const rollback = await controllerToolWorker.rollback(transactionId, {
      reason: "user_requested",
      sessionId,
      bindLegacySession: hasVerifiedLegacyReference,
    });
    await controllerToolWorker.syncTransaction(sessionId, transactionId);
    runtime.eventBus.emit({ type: "transaction.rolled_back", sessionId, transactionId, rollback });
    return sendJson(response, 200, { ok: true, rollback, transaction: controllerToolWorker.getTransaction(transactionId), session: await store.readSession(sessionId) });
  }
  return false;
}

export function createRoundtableServer(options = {}) {
  const runtime = runtimeOptions(options);
  const publicDir = options.publicDir || defaultPublicDir;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!authorizeLocalRequest(request, response, url)) return;
      if (request.method === "OPTIONS") return sendJson(response, 204, {});
      await initializeRuntime(runtime);
      const parts = requestPathParts(url);
      if (request.method === "GET" && url.pathname === "/api/events") {
        return serveEvents(request, response, runtime, url);
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        const address = server.address();
        const localServices = runtime.localServicesProvider ? await runtime.localServicesProvider() : null;
        return sendJson(response, 200, {
          ok: true,
          service: SERVICE_ID,
          pid: process.pid,
          host: typeof address === "object" && address ? address.address : defaultHost,
          port: typeof address === "object" && address ? address.port : defaultPort,
          repoRoot: runtime.repoRoot,
          storage: !runtime.requireWorkspaceSelection || runtime.workspaceRegistry.active || runtime.explicitStore ? runtime.store.describe() : null,
          workspace: runtime.workspaceRegistry.describe(),
          sessionsDir: !runtime.requireWorkspaceSelection || runtime.workspaceRegistry.active || runtime.explicitStore ? runtime.store.sessionsDir : null,
          controlStore: runtime.controlStore?.describe?.() || null,
          providers: runtime.providers.length,
          mvpProviders: [...runtime.adapters.keys()],
          browser: runtime.browserManager.status(),
          extensionBridge: runtime.extensionRelay.status(),
          activeRuns: runtime.runRegistry.list().filter((run) => ["running", "paused", "waiting_recovery"].includes(run.status)),
          localServices,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/providers") {
        return sendJson(response, 200, { ok: true, providers: runtime.providers });
      }
      if (request.method === "GET" && url.pathname === "/api/extension/status") {
        return sendJson(response, 200, { ok: true, extensionBridge: runtime.extensionRelay.status() });
      }
      if (request.method === "POST" && url.pathname === "/api/extension/register") {
        const payload = await readJson(request);
        const client = runtime.extensionRelay.register(payload.clientId, {
          available: payload.available,
          extensionVersion: payload.extensionVersion,
          bridgeRevision: payload.bridgeRevision,
        });
        return sendJson(response, 200, { ok: true, client, extensionBridge: runtime.extensionRelay.status() });
      }
      if (request.method === "POST" && url.pathname === "/api/extension/heartbeat") {
        const payload = await readJson(request);
        const client = runtime.extensionRelay.heartbeat(payload.clientId, {
          available: payload.available,
          extensionVersion: payload.extensionVersion,
          bridgeRevision: payload.bridgeRevision,
        });
        return sendJson(response, 200, { ok: true, client, extensionBridge: runtime.extensionRelay.status() });
      }
      if (request.method === "GET" && url.pathname === "/api/extension/poll") {
        const clientId = url.searchParams.get("clientId");
        const command = runtime.extensionRelay.poll(clientId);
        return sendJson(response, 200, { ok: true, command });
      }
      if (request.method === "POST" && url.pathname === "/api/extension/result") {
        const payload = await readJson(request);
        const completion = runtime.extensionRelay.complete(payload.clientId, payload.commandId, payload.result);
        return sendJson(response, 200, { ok: true, completion });
      }
      if (url.pathname === "/api/browser/status" && request.method === "GET") {
        return sendJson(response, 200, { ok: true, browser: runtime.browserManager.status() });
      }
      if (url.pathname === "/api/browser/connect" && request.method === "POST") {
        const payload = await readJson(request);
        await runtime.browserManager.connect({ providers: payload.providers });
        const reconciliation = await Promise.resolve(runtime.browserManager.reconcilePageLeases?.({ refresh: false })).catch(() => null);
        const browser = runtime.browserManager.status();
        runtime.eventBus.emit({ type: "browser.connected", browser });
        return sendJson(response, 200, { ok: true, browser, ...(reconciliation ? { reconciliation } : {}) });
      }
      if (url.pathname === "/api/browser/bind" && request.method === "POST") {
        const payload = await readJson(request);
        const providerId = String(payload.providerId || "").trim();
        const providerUrl = String(payload.url || "").trim();
        const tabId = Number(payload.tabId);
        const hasTabId = Number.isInteger(tabId);
        if (!providerId || (!providerUrl && !hasTabId)) {
          const error = new Error("Provider id and a URL or tab id are required.");
          error.code = "INVALID_BROWSER_BINDING";
          throw error;
        }
        const threadKey = payload.threadKey ? String(payload.threadKey) : null;
        const result = await runtime.browserManager.bindProviderPage(
          providerId,
          runtime.browserManager.mode === "extension" ? { url: providerUrl || null, tabId: hasTabId ? tabId : null } : providerUrl,
          { threadKey, sessionId: payload.sessionId || null, seatId: payload.seatId || providerId }
        );
        const binding = {
          providerId: String(result.providerId || providerId),
          status: String(result.status || "verified"),
          url: sanitizePageUrl(result.url),
          ...(Number.isInteger(result.tabId) ? { tabId: result.tabId } : {}),
        };
        const browser = runtime.browserManager.status();
        runtime.eventBus.emit({ type: "browser.provider_bound", providerId, binding });
        return sendJson(response, 200, { ok: true, binding, browser });
      }
      if (url.pathname === "/api/browser/unbind" && request.method === "POST") {
        const payload = await readJson(request);
        const providerId = String(payload.providerId || "").trim();
        if (!providerId) {
          const error = new Error("Provider id is required.");
          error.code = "INVALID_BROWSER_BINDING";
          throw error;
        }
        const removed = runtime.browserManager.unbindProvider(providerId, { threadKey: payload.threadKey || null });
        const browser = runtime.browserManager.status();
        runtime.eventBus.emit({ type: "browser.provider_unbound", providerId, removed });
        return sendJson(response, 200, { ok: true, providerId, removed, browser });
      }
      if (url.pathname === "/api/browser/open" && request.method === "POST") {
        const payload = await readJson(request);
        const providerIds = Array.isArray(payload.providers) && payload.providers.length
          ? payload.providers.map(String)
          : [...runtime.adapters.keys()];
        const pages = await runtime.browserManager.openProviders(providerIds);
        runtime.eventBus.emit({ type: "browser.providers_opened", pages });
        return sendJson(response, 200, { ok: true, pages, browser: runtime.browserManager.status() });
      }
      if (parts[0] === "api" && parts[1] === "storage") {
        const handled = await handleStorageRoute(request, response, runtime, parts);
        if (handled !== false) return handled;
      }
      if (parts[0] === "api" && parts[1] === "workspaces") {
        const handled = await handleWorkspaceRoute(request, response, runtime, parts);
        if (handled !== false) return handled;
      }
      if (parts[0] === "api" && parts[1] === "permissions") {
        const handled = await handlePermissionRoute(request, response, runtime, parts);
        if (handled !== false) return handled;
      }
      if (parts[0] === "api" && parts[1] === "sessions") {
        const handled = await handleSessionRoute(request, response, runtime, url, parts);
        if (handled !== false) return handled;
      }
      if (request.method === "GET" && url.pathname.startsWith("/vendor/")) return serveVendor(request, response);
      if (request.method === "GET") return serveStatic(request, response, publicDir);
      return sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
    } catch (error) {
      return sendJson(response, errorStatus(error), {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || null,
        diagnostics: error?.diagnostics || null,
      });
    }
  });
  server.runtime = runtime;
  server.on("close", () => {
    void runtime.browserManager.close();
    runtime.extensionRelay.close();
    for (const controlStore of runtime.controlStores.values()) controlStore.close();
  });
  return server;
}

export {
  PROVIDERS,
  assertExtensionBridgePort,
  buildPrompt,
  createDefaultLayout,
  createTurnPlan,
  parseRoundtableCommand,
};

if (path.resolve(process.argv[1] || "") === __filename) {
  assertExtensionBridgePort(process.env.WEB_AGENTS_BROWSER_MODE || "cdp", defaultPort);
  const server = createRoundtableServer({
    requireWorkspaceSelection: process.env.WEB_AGENTS_REQUIRE_WORKSPACE !== "0",
  });
  server.listen(defaultPort, defaultHost, () => {
    console.log(`Web Agents roundtable listening at http://${defaultHost}:${defaultPort}`);
    console.log(`Data root: ${server.runtime.store.dataRoot || "initializing"}`);
    console.log(`Browser profile: ${server.runtime.browserManager.profileDir}`);
  });
}
