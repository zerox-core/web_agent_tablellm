import { randomUUID } from "node:crypto";

import { AutomationError } from "../automation/errors.mjs";
import { tailWindowForProgress } from "../automation/progress-reporter.mjs";
import {
  coerceSettings,
  getProvider,
  getProviderLabel,
  isProviderHealthy,
} from "../core/providers.mjs";
import { normalizeRoleOverrides, pendingInterventionsForPlan, resolveSeatRole } from "../core/discussion-session-state.mjs";
import { parseRoundtableCommand } from "./command-parser.mjs";
import { buildPrompt, DISCUSSION_STAGES, getDiscussionStage } from "./context-builder.mjs";
import { compressSessionContext, CONTEXT_COMPRESSION_SCHEMA } from "./context-compressor.mjs";
import { applySeatProjection, projectContextForSeat } from "./context-projector.mjs";
import { appendDiscussionCycle, decideCycleContinuation, summarizeDiscussionCycle } from "./discussion-cycle.mjs";
import { parseParticipationResult } from "./participation-result.mjs";
import { extractReplyRelations } from "./reply-relations.mjs";
import { normalizeRoundtableReply } from "./reply-contract.mjs";
import {
  decideReplyCommit,
  isCommittedReplyEvent,
  normalizeReplyIdentity,
} from "./reply-lifecycle.mjs";
import { executionRecordFromTurn, upsertExecutionIndex } from "./execution-index.mjs";
import {
  analyzeReplyQuality,
  isTechnicalFailure,
  technicalFailureForResult,
} from "./quality-analyzer.mjs";

function createTurn(commandId, providerId, session, overrides = {}) {
  const id = randomUUID();
  return {
    id,
    commandId,
    round: null,
    sequence: null,
    providerId,
    providerLabel: getProviderLabel(providerId, session.participants),
    role: "discussion",
    stage: null,
    countsTowardRounds: true,
    status: "planned",
    prompt: null,
    attempts: 0,
    providerAttempts: {},
    idempotencyKey: `roundtable-turn:${id}`,
    attemptId: null,
    sendState: "NOT_SENT",
    ...overrides,
  };
}

function participantFor(session, providerId) {
  return session?.participants?.find((participant) => participant.id === providerId) || null;
}

function isClosureTurn(turn) {
  return turn?.role === "closure" || turn?.role === "host_summary" || turn?.stage === DISCUSSION_STAGES.closure.id;
}

function writeExecutorForTurn(plan, turn) {
  if (isClosureTurn(turn)) return plan.writeExecutorId || turn.providerId;
  if (plan.mode === "direct") return turn.providerId;
  // A missing executor defaults to the caller in ControllerToolWorker, so proposal turns need an explicit read-only principal.
  return `roundtable-read-only:${plan.id}:${turn.id}`;
}

const LOCAL_TOOL_INTENT = /(?:[a-z]:[\\/]|(?:读取|打开|检查|分析|修改|编辑|写入|创建|删除|移动|搜索|列出).{0,16}(?:本地|文件|目录|路径|代码库|仓库)|(?:本地|文件|目录|路径|代码库|仓库).{0,16}(?:读取|打开|检查|分析|修改|编辑|写入|创建|删除|移动|搜索|列出))/iu;

export function requiresLocalToolProtocol(plan = {}) {
  if (plan.writeExecutorId) return true;
  return LOCAL_TOOL_INTENT.test(String(plan.originalTask || plan.commandText || ""));
}

export function isWorkbenchEnabled(session = {}) {
  return session?.settings?.workbenchEnabled === true;
}

// The workbench switch is the master gate: a session only sees the tool protocol
// (and the tool execution loop) after it explicitly opts in; the default is off.
export function toolProtocolEnabledFor(session = {}, plan = {}) {
  return isWorkbenchEnabled(session) && requiresLocalToolProtocol(plan);
}

const TERMINAL_TURN_STATUSES = new Set(["completed", "passed", "absent", "skipped", "cancelled"]);
const REPLAY_BLOCKING_PHASES = new Set(["submitting", "submitted", "capturing", "captured", "send_unknown", "completed"]);
const NON_RETRYABLE_TECHNICAL_CODES = new Set(["PROVIDER_PAGE_NOT_BOUND", "PROVIDER_PAGE_IN_USE"]);

function sendStateForPhase(phase, fallback = "NOT_SENT") {
  const normalized = String(phase || "").trim().toLowerCase();
  return {
    prepared: "NOT_SENT",
    submitting: "SENDING",
    submitted: "SENT",
    capturing: "CAPTURING",
    captured: "CAPTURED",
    completed: "COMMITTED",
    committed: "COMMITTED",
    send_unknown: "SEND_UNKNOWN",
  }[normalized] || fallback;
}

function requiresExplicitRecovery(error) {
  return new Set(["PERMISSION_REQUIRED", "SEND_UNKNOWN"]).has(error?.code);
}

function canDegradeToAbsence(error, options = {}) {
  if (error?.code === "SEND_UNKNOWN" && !options.runId) return true;
  return !requiresExplicitRecovery(error);
}

function errorFromPersistedTurn(turn) {
  if (!turn || TERMINAL_TURN_STATUSES.has(turn.status)) return null;
  if (turn.status === "waiting_recovery" || turn.status === "failed") {
    return new AutomationError(
      turn.error?.code || "RUN_INTERRUPTED",
      turn.error?.message || "The interrupted turn requires an explicit recovery decision.",
      turn.error?.diagnostics || {},
    );
  }
  if (turn.status === "running" && (REPLAY_BLOCKING_PHASES.has(turn.executionPhase) || turn.sendState === "SEND_UNKNOWN")) {
    const code = turn.sendState === "SEND_UNKNOWN" || turn.executionPhase === "send_unknown"
      ? "SEND_UNKNOWN"
      : "EXECUTION_REPLAY_BLOCKED";
    return new AutomationError(
      code,
      code === "SEND_UNKNOWN"
        ? `${turn.providerLabel} may have received the prompt, but the send result is unknown; confirm before retrying.`
        : `${turn.providerLabel} already submitted execution ${turn.executionId}; choose retry, skip, or provide a manual reply.`,
      { turnId: turn.id, executionId: turn.executionId, attemptId: turn.attemptId, idempotencyKey: turn.idempotencyKey, phase: turn.executionPhase },
    );
  }
  return null;
}

function firstHealthyProvider(session, providerIds, excluded = new Set()) {
  for (const providerId of providerIds) {
    if (!providerId || excluded.has(providerId)) continue;
    if (isProviderHealthy(participantFor(session, providerId), session?.threads?.[providerId])) return providerId;
  }
  return null;
}

export function selectHealthyClosureProvider(session, plan, excludedProviderId = null) {
  const excluded = new Set(excludedProviderId ? [excludedProviderId] : []);
  const completed = new Set(
    (plan?.turns || [])
      .filter((turn) => !isClosureTurn(turn) && turn.status === "completed")
      .map((turn) => turn.providerId),
  );
  const targetIds = (plan?.targets || []).filter((providerId) => completed.has(providerId));
  return firstHealthyProvider(session, targetIds, excluded)
    || firstHealthyProvider(session, plan?.targets || [], excluded)
    || firstHealthyProvider(session, (session?.participants || []).map((participant) => participant.id), excluded);
}

function initialClosureProvider(session, parsed) {
  const hostId = parsed.hostId || session?.hostId || null;
  if (hostId && isProviderHealthy(participantFor(session, hostId), session?.threads?.[hostId])) {
    return { providerId: hostId, fallbackFromProviderId: null, fallbackReason: null };
  }
  const fallback = firstHealthyProvider(session, parsed.targets || [], new Set(hostId ? [hostId] : []));
  return {
    providerId: fallback || hostId || parsed.targets?.[0] || null,
    fallbackFromProviderId: hostId && fallback ? hostId : null,
    fallbackReason: hostId && fallback ? "HOST_UNHEALTHY_AT_PLAN_CREATION" : null,
  };
}

export function createTurnPlan(session, commandInput, settings = session?.settings) {
  const parsed = parseRoundtableCommand(commandInput, session, settings);
  const requestedWriteExecutorId = typeof commandInput === "object" && commandInput !== null
    ? commandInput.writeExecutorId ?? commandInput.permissions?.writeExecutorId ?? null
    : null;
  const commandId = randomUUID();
  const turns = [];
  const closure = initialClosureProvider(session, parsed);

  if (parsed.conversationMode === "relay") {
    const relayProviders = parsed.route.filter((providerId) => providerId !== parsed.hostId);
    relayProviders.forEach((providerId, index) => {
      turns.push(createTurn(commandId, providerId, session, {
        round: 1,
        sequence: index + 1,
        role: "relay",
        stage: "relay",
      }));
    });
    if (closure.providerId) {
      turns.push(createTurn(commandId, closure.providerId, session, {
        round: null,
        sequence: parsed.route.length,
        role: "host_summary",
        stage: DISCUSSION_STAGES.closure.id,
        countsTowardRounds: false,
        fallbackFromProviderId: closure.fallbackFromProviderId,
        fallbackReason: closure.fallbackReason,
      }));
    }
  }

  const closureTurn = turns.find(isClosureTurn) || null;
  const roleOverrides = typeof commandInput === "object" && commandInput !== null
    ? normalizeRoleOverrides(session, commandInput.roleOverrides || {}, parsed.targets)
    : {};
  const plan = {
    id: commandId,
    commandText: parsed.commandText,
    instruction: parsed.instruction,
    originalTask: parsed.originalTask || parsed.instruction,
    references: parsed.references || [],
    mentionTokens: parsed.mentionTokens || [],
    routingSource: parsed.routingSource,
    structuredRouting: Boolean(parsed.structuredRouting),
    targets: parsed.targets,
    selectedTargets: parsed.selectedTargets || parsed.targets,
    rounds: parsed.rounds,
    maxCycles: parsed.rounds,
    currentCycle: parsed.conversationMode === "discussion" ? 1 : null,
    cycles: [],
    roleOverrides,
    mode: parsed.mode,
    conversationMode: parsed.conversationMode,
    route: parsed.route || [],
    hostId: parsed.hostId || session.hostId || null,
    closureHostId: parsed.hostId || session.hostId || null,
    writeExecutorId: requestedWriteExecutorId ? String(requestedWriteExecutorId) : null,
    effectiveClosureProviderId: closureTurn?.providerId || null,
    closureTurnId: closureTurn?.id || null,
    status: "planned",
    createdAt: new Date().toISOString(),
    completedAt: null,
    turns,
  };
  if (parsed.conversationMode === "discussion") {
    appendDiscussionCycle(plan, session, { cycleNumber: 1 });
  }
  return plan;
}

function commandEvent(plan, settings) {
  return {
    id: randomUUID(),
    type: "command",
    providerId: null,
    content: plan.commandText,
    commandId: plan.id,
    round: null,
    metadata: {
      targets: plan.targets,
      selectedTargets: plan.selectedTargets,
      references: plan.references,
      rounds: plan.rounds,
      maxCycles: plan.maxCycles,
      roleOverrides: plan.roleOverrides,
      mode: plan.mode,
      conversationMode: plan.conversationMode,
      route: plan.route,
      hostId: plan.hostId,
      closureTurnId: plan.closureTurnId,
      writeExecutorId: plan.writeExecutorId,
      routingSource: plan.routingSource,
      executionMode: settings.mode,
    },
    createdAt: new Date().toISOString(),
  };
}

function latestSuccessfulBaton(session, plan) {
  return [...(session.events || [])].reverse().find((event) =>
    event.commandId === plan.id
      && isCommittedReplyEvent(event)
      && event.metadata?.role !== "closure"
      && event.metadata?.role !== "host_summary"
  ) || null;
}

function planAbsences(session, plan) {
  return (session.events || []).filter((event) => event.commandId === plan.id && event.type === "absence");
}

function buildMockReply(session, plan, turn) {
  const label = getProvider(turn.providerId, session.participants)?.label || turn.providerLabel;
  const previous = latestSuccessfulBaton(session, plan);
  if (isClosureTurn(turn)) {
    return [
      `[Mock ${label} · ${plan.conversationMode === "relay" ? "东家总结" : "自动收束"}]`,
      `我已回到原始任务“${plan.originalTask}”。`,
      previous ? `最后成功观点是：${previous.content.split("\n").at(-1)}` : "此前没有成功观点。",
      "最终汇报：先建立评价标准，再进行高质量样本对比、主动复盘和跨模型交叉审查。",
    ].join("\n");
  }
  if (plan.conversationMode === "relay") {
    return [
      `[Mock ${label} · 传递第 ${turn.sequence} 棒]`,
      `我保留原始任务：“${plan.originalTask}”。`,
      previous ? "我已看到最后成功接力棒，并在此基础上补充可执行步骤。" : "我是本次传递的第一位有效回答者。",
      "新增观点：训练审美需要持续输入优质样本、建立比较维度，并记录每次选择背后的理由。",
    ].join("\n");
  }
  return [
    `[Mock ${label} · 第 ${turn.round} 轮]`,
    `当前阶段：${turn.stage}。`,
    `我收到的原始任务是：“${plan.originalTask}”。`,
    "当前可执行建议：先明确判断标准，再拆分证据链，最后把争议点交给下一轮模型交叉检查。",
  ].join("\n");
}

function serializeError(error) {
  return {
    code: error?.code || "PROVIDER_EXECUTION_FAILED",
    message: error?.message || String(error),
    stack: error?.stack || null,
    diagnostics: error?.diagnostics || null,
    details: error?.details || null,
  };
}

function projectionSummary(projection) {
  return {
    providerId: projection.providerId,
    fromEventIndex: projection.fromEventIndex,
    throughEventIndex: projection.throughEventIndex,
    sync: projection.sync,
    capacity: projection.capacity,
    compression: projection.compression,
  };
}

function cloneCheckpointMetadata(metadata) {
  try {
    return structuredClone(metadata && typeof metadata === "object" ? metadata : {});
  } catch {
    return { serializationError: true };
  }
}

export class RoundtableScheduler {
  constructor({ store, worker = null, eventBus = null, runRegistry = null, contextCompression = {}, strictReplyCommit = false } = {}) {
    if (!store) throw new Error("STORE_REQUIRED");
    this.store = store;
    this.worker = worker;
    this.eventBus = eventBus;
    this.runRegistry = runRegistry;
    this.contextCompression = contextCompression;
    this.strictReplyCommit = Boolean(strictReplyCommit);
    this.prepareLocks = new Map();
    this.executionCheckpointLocks = new Map();
  }

  emit(type, detail) {
    this.eventBus?.emit({ type, at: new Date().toISOString(), ...detail });
  }

  async prepareCommand(sessionId, payload = {}, options = {}) {
    const previous = this.prepareLocks.get(sessionId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.prepareLocks.set(sessionId, current);
    await previous;
    try {
      return await this.prepareCommandUnlocked(sessionId, payload, options);
    } finally {
      release();
      if (this.prepareLocks.get(sessionId) === current) this.prepareLocks.delete(sessionId);
    }
  }

  async prepareCommandUnlocked(sessionId, payload = {}, options = {}) {
    let plan;
    let session = await this.store.updateSession(sessionId, (current) => {
      const activePlan = current.plans?.find((candidate) => candidate.id === current.runtime?.activePlanId);
      if (activePlan && ["planned", "running", "waiting_recovery", "awaiting_continuation"].includes(activePlan.status)) {
        throw new Error("SESSION_RUN_ACTIVE");
      }
      const settingsPatch = typeof payload === "object" && payload !== null ? payload.settings || {} : {};
      current.settings = coerceSettings({ ...(current.settings || {}), ...settingsPatch });
      plan = createTurnPlan(current, payload, current.settings);
      plan.runId = options.runId || null;
      plan.status = "running";
      plan.startedAt = new Date().toISOString();
      current.plans = [...(current.plans || []), plan];
      current.runtime = {
        ...(current.runtime || {}),
        status: "running",
        activePlanId: plan.id,
        activeRunId: options.runId || null,
        error: null,
      };
      current.updatedAt = plan.startedAt;
      return current;
    });
    session = await this.store.appendEvents(sessionId, [commandEvent(plan, session.settings)]);
    this.emit("plan.started", { sessionId, planId: plan.id, runId: options.runId || null, plan });
    return { session, plan };
  }

  async executeCommand(sessionId, payload = {}, options = {}) {
    const prepared = await this.prepareCommand(sessionId, payload, options);
    return this.executePreparedPlan(sessionId, prepared.plan.id, options);
  }

  async executePreparedPlan(sessionId, planId, options = {}) {
    let session = await this.store.readSession(sessionId);
    const plan = session.plans.find((candidate) => candidate.id === planId);
    if (!plan) throw new Error("PLAN_NOT_FOUND");
    if (plan.status !== "running") throw new Error("PLAN_NOT_RUNNING");
    const replayBlockedTurn = !options.resumePersisted && plan.turns.find((turn) => {
      if (turn.status !== "running") return false;
      const checkpoints = (session.checkpoints || []).filter((candidate) => candidate.turnId === turn.id);
      return checkpoints.some((checkpoint) => REPLAY_BLOCKING_PHASES.has(checkpoint.phase))
        || REPLAY_BLOCKING_PHASES.has(turn.executionPhase);
    });
    if (replayBlockedTurn) {
      throw new AutomationError(
        "EXECUTION_REPLAY_BLOCKED",
        `${replayBlockedTurn.providerLabel} already submitted execution ${replayBlockedTurn.executionId}; manual recovery is required.`,
        { turnId: replayBlockedTurn.id, executionId: replayBlockedTurn.executionId },
      );
    }
    try {
      session = plan.conversationMode === "relay"
        ? await this.executeRelay(session, plan, options)
        : await this.executeDiscussion(session, plan, options);
      const postExecutionPlan = session.plans.find((candidate) => candidate.id === plan.id);
      if (postExecutionPlan?.status === "awaiting_continuation") {
        this.emit("plan.awaiting_continuation", { sessionId, planId: plan.id, runId: options.runId || null, plan: postExecutionPlan });
        return { session, plan: postExecutionPlan, awaitingContinuation: true };
      }
      session = await this.store.updateSession(sessionId, (current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === plan.id);
        if (!currentPlan) throw new Error("PLAN_NOT_FOUND");
        currentPlan.status = "completed";
        currentPlan.completedAt = new Date().toISOString();
        currentPlan.error = null;
        if (current.runtime?.activePlanId === plan.id) {
          current.runtime = {
            ...(current.runtime || {}),
            status: "idle",
            activePlanId: null,
            activeRunId: null,
            failedTurnId: null,
            error: null,
          };
        }
        current.updatedAt = currentPlan.completedAt;
        return current;
      });
      const savedPlan = session.plans.find((candidate) => candidate.id === plan.id);
      this.emit("plan.completed", { sessionId, planId: plan.id, runId: options.runId || null, plan: savedPlan });
      return { session, plan: savedPlan };
    } catch (error) {
      const cancelled = Boolean(options.signal?.aborted) || error?.code === "RUN_CANCELLED";
      const serialized = serializeError(error);
      session = await this.store.updateSession(sessionId, (current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === plan.id);
        const failedAt = new Date().toISOString();
        if (currentPlan) {
          currentPlan.status = cancelled ? "cancelled" : "failed";
          currentPlan.failedAt = failedAt;
          currentPlan.error = serialized;
        }
        if (current.runtime?.activePlanId === plan.id) {
          current.runtime = {
            ...(current.runtime || {}),
            status: cancelled ? "cancelled" : "failed",
            activePlanId: null,
            activeRunId: null,
            failedTurnId: null,
            error: serialized,
          };
        }
        current.updatedAt = failedAt;
        return current;
      });
      this.emit("plan.failed", {
        sessionId,
        planId: plan.id,
        runId: options.runId || null,
        cancelled,
        error: serialized,
      });
      throw error;
    }
  }

  async checkpoint(options) {
    if (options.signal?.aborted) throw options.signal.reason || Object.assign(new Error("RUN_CANCELLED"), { code: "RUN_CANCELLED" });
    if (options.runId && this.runRegistry) await this.runRegistry.waitIfPaused(options.runId);
    if (options.signal?.aborted) throw options.signal.reason || Object.assign(new Error("RUN_CANCELLED"), { code: "RUN_CANCELLED" });
  }

  prepareTurnPrompt(session, plan, turn, eventsSnapshot = session.events) {
    const snapshotSession = { ...session, events: eventsSnapshot };
    let projection = projectContextForSeat(snapshotSession, turn.providerId, {
      throughEventIndex: eventsSnapshot.length - 1,
    });
    const baton = latestSuccessfulBaton(snapshotSession, plan);
    const absences = planAbsences(snapshotSession, plan);
    const promptContext = {
      commandText: plan.commandText,
      originalTask: plan.originalTask,
      conversationMode: plan.conversationMode,
      round: turn.round,
      totalRounds: plan.rounds,
      cycleNumber: turn.cycleNumber || turn.round || 1,
      maxCycles: plan.maxCycles || plan.rounds,
      stage: turn.stage,
      role: turn.role,
      route: plan.route,
      sequence: turn.sequence,
      isClosure: isClosureTurn(turn),
      isHostSummary: isClosureTurn(turn),
      targets: plan.targets,
      lastSuccessfulBaton: baton,
      absences,
      fallbackFromProviderId: turn.fallbackFromProviderId || null,
      fallbackReason: turn.fallbackReason || null,
      roleOverrides: plan.roleOverrides || {},
      seatRole: resolveSeatRole(snapshotSession, turn.providerId, plan.roleOverrides || {}),
      enableToolProtocol: toolProtocolEnabledFor(snapshotSession, plan),
    };
    const buildProjectedPrompt = (targetSession, targetProjection) => buildPrompt(
      targetSession,
      turn.providerId,
      { ...promptContext, projection: targetProjection },
    );
    let prompt = buildProjectedPrompt(snapshotSession, projection);
    const previousCompression = structuredClone(snapshotSession.context?.compression || null);
    try {
      const compressor = this.contextCompression.compress || compressSessionContext;
      const compressionResult = compressor(snapshotSession, {
        prompt,
        providerId: turn.providerId,
        buildPrompt: (targetSession) => {
          const targetProjection = projectContextForSeat(targetSession, turn.providerId, {
            throughEventIndex: eventsSnapshot.length - 1,
          });
          return buildProjectedPrompt(targetSession, targetProjection);
        },
        estimatePromptTokens: this.contextCompression.estimatePromptTokens,
        estimateEventTokens: this.contextCompression.estimateEventTokens,
        now: this.contextCompression.now,
      });
      if (compressionResult.changed) {
        projection = projectContextForSeat(snapshotSession, turn.providerId, {
          throughEventIndex: eventsSnapshot.length - 1,
        });
        prompt = buildProjectedPrompt(snapshotSession, projection);
      }
    } catch (error) {
      snapshotSession.context = snapshotSession.context && typeof snapshotSession.context === "object"
        ? snapshotSession.context
        : {};
      snapshotSession.context.compression = previousCompression || {
        schema: CONTEXT_COMPRESSION_SCHEMA,
        activeRevision: 0,
        active: null,
        revisions: [],
      };
      snapshotSession.context.compression.lastError = {
        code: error?.code || "COMPRESSION_FAILED",
        message: error?.message || String(error),
        at: new Date().toISOString(),
      };
    }
    turn.contextProjection = projectionSummary(projection);
    turn.prompt = prompt;
    return turn;
  }

  async commitPendingInterventions(sessionId, planId, cycleNumber) {
    let session = await this.store.readSession(sessionId);
    const pending = pendingInterventionsForPlan(session, planId);
    if (!pending.length) return session;
    const existingIds = new Set((session.events || []).map((event) => event.id));
    const now = new Date().toISOString();
    const events = pending
      .map((item) => ({
        id: `intervention:${item.id}`,
        type: "command",
        providerId: null,
        content: item.content,
        commandId: planId,
        round: cycleNumber,
        metadata: { intervention: true, interventionId: item.id },
        createdAt: item.createdAt || now,
      }))
      .filter((event) => !existingIds.has(event.id));
    if (events.length) session = await this.store.appendEvents(sessionId, events);
    const consumedIds = new Set(pending.map((item) => item.id));
    session = await this.store.updateSession(sessionId, (current) => {
      current.pendingInterventions = (current.pendingInterventions || []).filter((item) => !consumedIds.has(item.id));
      current.updatedAt = now;
      return current;
    });
    for (const event of events) this.emit("intervention.committed", { sessionId, planId, event });
    return session;
  }

  async executeDiscussionTurn(session, plan, turn, options, persistInOrder = (operation) => operation()) {
    const multiModel = new Set(plan.targets).size > 1;
    try {
      let result = await this.executeWithAutomaticRetry(session, plan, turn, options);
      let participation = parseParticipationResult(result.text);
      if (participation.kind === "invalid") {
        throw new AutomationError("EMPTY_CAPTURED_RESPONSE", `${turn.providerLabel} returned no usable discussion response.`);
      }
      if (participation.kind === "passed" && Number(turn.cycleNumber || turn.round) === 1) {
        throw new AutomationError("FIRST_CYCLE_PASS_NOT_ALLOWED", `${turn.providerLabel} must provide an independent first-cycle position.`);
      }
      if (participation.kind === "passed" && turn.mustRespond) {
        turn.participationCorrectionAttempts = 1;
        turn.prompt = `${turn.prompt}\n\n你在上一周期被直接点名，请用一至两句话明确回应；不要只返回 PASS。`;
        this.markTurnRunning(turn);
        this.emit("turn.started", { sessionId: session.id, planId: plan.id, runId: options.runId || null, turn, recovery: "participation_correction" });
        result = await this.executeWithAutomaticRetry(session, plan, turn, options);
        participation = parseParticipationResult(result.text);
        if (participation.kind === "passed") {
          throw new AutomationError("DIRECT_MENTION_UNANSWERED", `${turn.providerLabel} did not answer a direct mention.`);
        }
      }
      return persistInOrder(() => participation.kind === "passed"
        ? this.persistTurnPass(session, plan, turn, result, options)
        : this.persistTurnSuccess(session, plan, turn, { ...result, text: participation.content }, options));
    } catch (error) {
      if (multiModel && canDegradeToAbsence(error, options)) {
        return persistInOrder(() => this.persistTurnAbsence(session, plan, turn, error, options));
      }
      return persistInOrder(async () => {
        const latest = await this.persistTurnFailure(session, plan, turn, error, options);
        return this.recoverTurn(latest.id, plan.id, turn.id, error, options);
      });
    }
  }

  async ensureDiscussionClosureTurn(sessionId, planId) {
    return this.store.updateSession(sessionId, (current) => {
      const currentPlan = current.plans.find((candidate) => candidate.id === planId);
      if (!currentPlan) throw new Error("PLAN_NOT_FOUND");
      if (currentPlan.turns.some(isClosureTurn)) return current;
      if (!currentPlan.hostId) throw new Error("CLOSURE_HOST_REQUIRED");
      const turn = createTurn(currentPlan.id, currentPlan.hostId, current, {
        round: null,
        cycleNumber: null,
        role: "closure",
        stage: DISCUSSION_STAGES.closure.id,
        countsTowardRounds: false,
      });
      currentPlan.turns.push(turn);
      currentPlan.closureTurnId = turn.id;
      currentPlan.effectiveClosureProviderId = currentPlan.hostId;
      current.updatedAt = new Date().toISOString();
      return current;
    });
  }

  async executeDiscussion(session, initialPlan, options) {
    const planId = initialPlan.id;
    while (true) {
      await this.checkpoint(options);
      session = await this.store.readSession(session.id);
      let plan = session.plans.find((candidate) => candidate.id === planId);
      let cycle = [...(plan.cycles || [])].reverse().find((candidate) => candidate.status !== "completed") || plan.cycles?.at(-1);
      if (!cycle) {
        session = await this.store.updateSession(session.id, (current) => {
          const currentPlan = current.plans.find((candidate) => candidate.id === planId);
          appendDiscussionCycle(currentPlan, current, { cycleNumber: 1 });
          return current;
        });
        plan = session.plans.find((candidate) => candidate.id === planId);
        cycle = plan.cycles.at(-1);
      }

      const snapshot = session.events
        .slice(0, Number(cycle.snapshotThroughEventIndex) + 1)
        .map((event) => structuredClone(event));
      for (const turnId of cycle.turnIds) {
        session = await this.store.readSession(session.id);
        plan = session.plans.find((candidate) => candidate.id === planId);
        const persistedTurn = plan.turns.find((turn) => turn.id === turnId);
        if (!persistedTurn || TERMINAL_TURN_STATUSES.has(persistedTurn.status)) continue;
        const recoveryError = errorFromPersistedTurn(persistedTurn);
        if (!recoveryError) continue;
        if (!options.resumePersisted) throw recoveryError;
        session = await this.recoverTurn(session.id, planId, turnId, recoveryError, options);
      }
      session = await this.store.readSession(session.id);
      plan = session.plans.find((candidate) => candidate.id === planId);
      cycle = plan.cycles.find((candidate) => candidate.number === cycle.number);
      let startedTurnIds = [];
      session = await this.store.updateSession(session.id, (current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === planId);
        const currentCycle = currentPlan.cycles.find((candidate) => candidate.number === cycle.number);
        currentCycle.status = "running";
        currentCycle.startedAt ||= new Date().toISOString();
        const pendingTurns = currentCycle.turnIds
          .map((turnId) => currentPlan.turns.find((turn) => turn.id === turnId))
          .filter((turn) => !TERMINAL_TURN_STATUSES.has(turn.status));
        for (const turn of pendingTurns) {
          this.prepareTurnPrompt(current, currentPlan, turn, snapshot);
          this.markTurnRunning(turn);
        }
        startedTurnIds = pendingTurns.map((turn) => turn.id);
        currentPlan.currentCycle = currentCycle.number;
        current.updatedAt = currentCycle.startedAt;
        return current;
      });
      plan = session.plans.find((candidate) => candidate.id === planId);
      cycle = plan.cycles.find((candidate) => candidate.number === cycle.number);
      const turns = startedTurnIds.map((turnId) => plan.turns.find((turn) => turn.id === turnId));
      this.emit("cycle.started", { sessionId: session.id, planId, runId: options.runId || null, cycle });
      for (const turn of turns) this.emit("turn.started", { sessionId: session.id, planId, runId: options.runId || null, turn });
      let persistence = Promise.resolve();
      const persistInOrder = (operation) => {
        const queued = persistence.then(operation, operation);
        persistence = queued.catch(() => {});
        return queued;
      };
      await Promise.all(turns.map((turn) => this.executeDiscussionTurn(session, plan, turn, options, persistInOrder)));

      session = await this.store.updateSession(session.id, (current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === planId);
        const currentCycle = currentPlan.cycles.find((candidate) => candidate.number === cycle.number);
        const summary = summarizeDiscussionCycle(currentPlan, currentCycle);
        Object.assign(currentCycle, {
          status: summary.terminal ? "completed" : "running",
          completedAt: summary.terminal ? new Date().toISOString() : null,
          spokenCount: summary.spokenCount,
          passedCount: summary.passedCount,
          absentCount: summary.absentCount,
        });
        current.updatedAt = currentCycle.completedAt || new Date().toISOString();
        return current;
      });
      plan = session.plans.find((candidate) => candidate.id === planId);
      cycle = plan.cycles.find((candidate) => candidate.number === cycle.number);
      const summary = summarizeDiscussionCycle(plan, cycle);
      this.emit("cycle.completed", { sessionId: session.id, planId, runId: options.runId || null, cycle, summary });
      this.emit("round.completed", { sessionId: session.id, planId, runId: options.runId || null, round: cycle.number, stage: cycle.number === 1 ? "independent_position" : "cross_discussion" });

      const hasPendingInterventions = pendingInterventionsForPlan(session, planId).length > 0;
      const decision = decideCycleContinuation({
        results: summary.results,
        hasPendingInterventions,
        cycleNumber: cycle.number,
        maxCycles: plan.maxCycles || plan.rounds,
      });
      if (decision === "awaiting_capacity") {
        return this.store.updateSession(session.id, (current) => {
          const currentPlan = current.plans.find((candidate) => candidate.id === planId);
          currentPlan.status = "awaiting_continuation";
          current.runtime = { ...(current.runtime || {}), status: "awaiting_continuation", activePlanId: planId, activeRunId: null };
          current.updatedAt = new Date().toISOString();
          return current;
        });
      }
      if (decision === "close") break;

      session = await this.commitPendingInterventions(session.id, planId, cycle.number + 1);
      session = await this.store.updateSession(session.id, (current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === planId);
        if (!currentPlan.cycles.some((candidate) => candidate.number === cycle.number + 1)) {
          appendDiscussionCycle(currentPlan, current, {
            cycleNumber: cycle.number + 1,
            snapshotThroughEventIndex: current.events.length - 1,
          });
        }
        current.updatedAt = new Date().toISOString();
        return current;
      });
    }
    session = await this.store.readSession(session.id);
    const finishedPlan = session.plans.find((candidate) => candidate.id === planId);
    if (finishedPlan.mode === "direct") return session;
    session = await this.ensureDiscussionClosureTurn(session.id, planId);
    return this.executeClosure(session, planId, options);
  }

  async executeRelay(session, plan, options) {
    const relayTurnIds = plan.turns.filter((turn) => turn.role === "relay").map((turn) => turn.id);
    for (const turnId of relayTurnIds) {
      await this.checkpoint(options);
      session = await this.store.readSession(session.id);
      let savedPlan = session.plans.find((candidate) => candidate.id === plan.id);
      let turn = savedPlan.turns.find((candidate) => candidate.id === turnId);
      if (TERMINAL_TURN_STATUSES.has(turn.status)) continue;
      if (options.resumePersisted) {
        const recoveryError = errorFromPersistedTurn(turn);
        if (recoveryError) {
          session = await this.recoverTurn(session.id, plan.id, turn.id, recoveryError, options);
          continue;
        }
      }
      session = await this.store.updateSession(session.id, (current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === plan.id);
        const currentTurn = currentPlan.turns.find((candidate) => candidate.id === turnId);
        const contextSnapshot = current.events.map((event) => structuredClone(event));
        this.prepareTurnPrompt(current, currentPlan, currentTurn, contextSnapshot);
        this.markTurnRunning(currentTurn);
        current.updatedAt = new Date().toISOString();
        return current;
      });
      savedPlan = session.plans.find((candidate) => candidate.id === plan.id);
      turn = savedPlan.turns.find((candidate) => candidate.id === turnId);
      this.emit("turn.started", { sessionId: session.id, planId: plan.id, runId: options.runId || null, turn });
      try {
        const result = await this.executeWithAutomaticRetry(session, savedPlan, turn, options);
        session = await this.persistTurnSuccess(session, savedPlan, turn, result, options);
      } catch (error) {
        if (requiresExplicitRecovery(error)) {
          session = await this.persistTurnFailure(session, savedPlan, turn, error, options);
          session = await this.recoverTurn(session.id, plan.id, turn.id, error, options);
        } else {
          session = await this.persistTurnAbsence(session, savedPlan, turn, error, options);
        }
      }
    }
    return this.executeClosure(session, plan.id, options);
  }

  async executeClosure(session, planId, options) {
    session = await this.store.readSession(session.id);
    let plan = session.plans.find((candidate) => candidate.id === planId);
    let turn = plan.turns.find(isClosureTurn);
    if (!turn) return session;
    if (TERMINAL_TURN_STATUSES.has(turn.status)) return session;
    await this.checkpoint(options);
    if (options.resumePersisted) {
      const recoveryError = errorFromPersistedTurn(turn);
      if (recoveryError) {
        return this.recoverTurn(session.id, planId, turn.id, recoveryError, options);
      }
    }
    session = await this.store.updateSession(session.id, (current) => {
      const currentPlan = current.plans.find((candidate) => candidate.id === planId);
      const currentTurn = currentPlan.turns.find(isClosureTurn);
      this.prepareTurnPrompt(current, currentPlan, currentTurn, current.events.map((event) => structuredClone(event)));
      this.markTurnRunning(currentTurn);
      current.updatedAt = new Date().toISOString();
      return current;
    });
    plan = session.plans.find((candidate) => candidate.id === planId);
    turn = plan.turns.find(isClosureTurn);
    this.emit("turn.started", { sessionId: session.id, planId, runId: options.runId || null, turn });
    try {
      const result = await this.executeWithAutomaticRetry(session, plan, turn, options);
      return this.persistTurnSuccess(session, plan, turn, result, options);
    } catch (hostError) {
      if (requiresExplicitRecovery(hostError)) {
        session = await this.persistTurnFailure(session, plan, turn, hostError, options);
        return this.recoverTurn(session.id, planId, turn.id, hostError, options);
      }
      if (plan.conversationMode === "discussion") {
        return this.persistTurnAbsence(session, plan, turn, hostError, options);
      }
      session = await this.mergeLatestTurnState(session.id, plan, turn);
      plan = session.plans.find((candidate) => candidate.id === planId);
      turn = plan.turns.find(isClosureTurn);
      const failedProviderId = turn.providerId;
      turn.providerFailures = [
        ...(turn.providerFailures || []),
        { providerId: failedProviderId, error: serializeError(hostError), attempts: turn.providerAttempts?.[failedProviderId] || 0 },
      ];
      this.emit("closure.provider_failed", {
        sessionId: session.id,
        planId,
        runId: options.runId || null,
        providerId: failedProviderId,
        error: serializeError(hostError),
      });
      const fallbackId = selectHealthyClosureProvider(session, plan, failedProviderId);
      if (!fallbackId) return this.persistTurnAbsence(session, plan, turn, hostError, options);

      session = await this.store.updateSession(session.id, (current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === planId);
        const currentTurn = currentPlan.turns.find(isClosureTurn);
        currentTurn.fallbackFromProviderId = failedProviderId;
        currentTurn.fallbackReason = `${hostError.code || "PROVIDER_EXECUTION_FAILED"}: ${hostError.message || String(hostError)}`;
        currentTurn.providerId = fallbackId;
        currentTurn.providerLabel = getProviderLabel(fallbackId, current.participants);
        currentTurn.status = "planned";
        currentPlan.effectiveClosureProviderId = fallbackId;
        currentPlan.closureFallback = {
          fromProviderId: failedProviderId,
          toProviderId: fallbackId,
          reason: currentTurn.fallbackReason,
        };
        this.prepareTurnPrompt(current, currentPlan, currentTurn, current.events.map((event) => structuredClone(event)));
        this.markTurnRunning(currentTurn);
        current.updatedAt = new Date().toISOString();
        return current;
      });
      plan = session.plans.find((candidate) => candidate.id === planId);
      turn = plan.turns.find(isClosureTurn);
      this.emit("closure.fallback_started", {
        sessionId: session.id,
        planId,
        runId: options.runId || null,
        turn,
      });
      try {
        const result = await this.executeWithAutomaticRetry(session, plan, turn, options);
        return this.persistTurnSuccess(session, plan, turn, result, options, "host_fallback");
      } catch (fallbackError) {
        if (requiresExplicitRecovery(fallbackError)) {
          session = await this.persistTurnFailure(session, plan, turn, fallbackError, options);
          return this.recoverTurn(session.id, planId, turn.id, fallbackError, options);
        }
        return this.persistTurnAbsence(session, plan, turn, fallbackError, options);
      }
    }
  }

  markTurnRunning(turn, { reuseExecutionId = false } = {}) {
    turn.status = "running";
    turn.startedAt = turn.startedAt || new Date().toISOString();
    turn.failedAt = null;
    turn.error = null;
    if (reuseExecutionId && turn.executionId) {
      turn.resumingExecution = true;
      turn.executionResumeAttempts = (turn.executionResumeAttempts || 0) + 1;
      return;
    }
    turn.resumingExecution = false;
    turn.attempts = (turn.attempts || 0) + 1;
    turn.providerAttempts = turn.providerAttempts || {};
    turn.providerAttempts[turn.providerId] = (turn.providerAttempts[turn.providerId] || 0) + 1;
    turn.idempotencyKey ||= `roundtable-turn:${turn.id}`;
    turn.attemptId = `${turn.idempotencyKey}:${turn.providerId}:attempt:${turn.providerAttempts[turn.providerId]}`;
    turn.executionId = `${turn.id}:${turn.providerId}:${turn.providerAttempts[turn.providerId]}`;
    turn.sendState = "NOT_SENT";
  }

  async executeWithAutomaticRetry(session, plan, turn, options) {
    let error = null;
    for (let automaticAttempt = 0; automaticAttempt <= 1; automaticAttempt += 1) {
      try {
        const result = await this.executeProvider(session, plan, turn, options);
        const resultFailure = technicalFailureForResult(result);
        if (resultFailure) throw resultFailure;
        return result;
      } catch (caught) {
        const sendMayHaveStarted = turn.sendState === "SENDING"
          || turn.executionPhase === "submitting"
          || turn.sendState === "CAPTURING"
          || turn.executionPhase === "submitted";
        if (sendMayHaveStarted && !["LOGIN_REQUIRED", "HUMAN_VERIFICATION_REQUIRED"].includes(caught?.code)) {
          turn.sendState = "SEND_UNKNOWN";
          const uncertainPhase = turn.executionPhase || "submitting";
          await this.upsertExecutionCheckpoint({
            sessionId: session.id,
            planId: plan.id,
            turnId: turn.id,
            executionId: turn.executionId,
            attemptId: turn.attemptId,
            idempotencyKey: turn.idempotencyKey,
            providerId: turn.providerId,
            phase: uncertainPhase,
            metadata: {
              sendState: "SEND_UNKNOWN",
              cause: serializeError(caught),
            },
          });
          error = new AutomationError(
            "SEND_UNKNOWN",
            `${turn.providerLabel} send outcome is unknown; automatic replay is blocked.`,
            {
              idempotencyKey: turn.idempotencyKey,
              attemptId: turn.attemptId,
              cause: serializeError(caught),
            },
          );
        } else {
          error = technicalFailureForResult(null, caught);
        }
        turn.attemptErrors = [
          ...(turn.attemptErrors || []),
          { providerId: turn.providerId, automaticAttempt: automaticAttempt + 1, error: serializeError(error) },
        ];
        if (automaticAttempt >= 1
          || NON_RETRYABLE_TECHNICAL_CODES.has(error?.code)
          || !isTechnicalFailure(error)
          || REPLAY_BLOCKING_PHASES.has(turn.executionPhase)) {
          throw error;
        }
        await this.checkpoint(options);
        this.emit("turn.retrying", {
          sessionId: session.id,
          planId: plan.id,
          runId: options.runId || null,
          turn,
          error: serializeError(error),
        });
        this.markTurnRunning(turn);
        this.emit("turn.started", {
          sessionId: session.id,
          planId: plan.id,
          runId: options.runId || null,
          turn,
          recovery: "automatic_retry",
        });
      }
    }
    throw error;
  }

  async persistTurnSuccess(session, plan, turn, result, options, recovery = null) {
    const content = String(result.text);
    const latestBeforeWrite = await this.store.readSession(session.id);
    const snapshotThrough = turn.contextProjection?.throughEventIndex ?? latestBeforeWrite.events.length - 1;
    turn.replyRelations = plan.conversationMode === "discussion" && !isClosureTurn(turn)
      ? extractReplyRelations({
          content,
          sourceProviderId: turn.providerId,
          commandId: plan.id,
          participants: latestBeforeWrite.participants,
          events: latestBeforeWrite.events.slice(0, snapshotThrough + 1),
        })
      : [];
    const previousReplies = (latestBeforeWrite.events || []).filter(isCommittedReplyEvent);
    const structured = normalizeRoundtableReply(content);
    const quality = analyzeReplyQuality(content, {
      capture: result.capture,
      previousReplies,
      originalTask: plan.originalTask,
      structureStatus: structured.status,
    });
    const replyIdentity = normalizeReplyIdentity({
      providerId: turn.providerId,
      content,
      capture: result.capture,
      capturedAt: result.capture?.capturedAt || result.capture?.settledAt,
    });
    const strictReplyCommit = this.strictReplyCommit && session.settings?.mode !== "mock";
    const commit = decideReplyCommit({
      strict: strictReplyCommit,
      structureStatus: structured.status,
      quality,
      identity: replyIdentity,
      recovery,
    });
    const replyPath = await this.store.writeReply(session.id, {
      planId: plan.id,
      turnId: turn.id,
      providerId: turn.providerId,
      round: turn.round,
      content,
    });
    session = await this.store.updateSession(session.id, (current) => {
      const savedPlan = current.plans.find((candidate) => candidate.id === plan.id);
      const savedTurn = savedPlan?.turns.find((candidate) => candidate.id === turn.id);
      if (!savedPlan || !savedTurn) throw new Error("TURN_NOT_FOUND");
      Object.assign(savedTurn, turn, {
        status: "completed",
        completedAt: new Date().toISOString(),
        replyPath,
        capture: result.capture || null,
        quality: {
          flags: quality.flags,
          confidence: quality.confidence,
          lowConfidence: quality.lowConfidence,
          sideEffectsAllowed: quality.sideEffectsAllowed,
          structureStatus: structured.status,
          structureErrors: structured.errors,
          replyIdentity,
          commitStatus: commit.status,
          commitReason: commit.reason,
        },
        structuredReply: structured.value,
        replyRelations: turn.replyRelations,
        error: null,
      });
      if (recovery) savedTurn.recovery = recovery;
      for (const key of ["effectiveClosureProviderId", "closureFallback", "writeExecutorId"]) {
        if (plan[key] !== undefined) savedPlan[key] = plan[key];
      }
      applySeatProjection(current, {
        providerId: savedTurn.providerId,
        throughEventIndex: savedTurn.contextProjection?.throughEventIndex ?? current.events.length - 1,
        sync: savedTurn.contextProjection?.sync,
      }, {
        promptChars: String(savedTurn.prompt || "").length,
        replyChars: content.length,
      });
      current.updatedAt = savedTurn.completedAt;
      return current;
    });
    const savedPlan = session.plans.find((candidate) => candidate.id === plan.id);
    const savedTurn = savedPlan.turns.find((candidate) => candidate.id === turn.id);
    const rawEvent = this.createRawReplyEvent(session, savedPlan, savedTurn, content, recovery, replyIdentity);
    const validatedEvent = this.createValidatedReplyEvent(session, savedPlan, savedTurn, content, recovery, quality, structured, replyIdentity, commit);
    const event = this.createReplyEvent(session, savedPlan, savedTurn, content, recovery, quality, structured.value, structured.status, replyIdentity, commit);
    await this.store.appendAudit({ kind: rawEvent.type, sessionId: session.id, event: rawEvent });
    await this.store.appendAudit({ kind: validatedEvent.type, sessionId: session.id, event: validatedEvent });
    session = await this.store.appendEvents(session.id, [event]);
    if (savedTurn.executionId) {
      session = await this.upsertExecutionCheckpoint({
        sessionId: session.id,
        planId: savedPlan.id,
        turnId: savedTurn.id,
        executionId: savedTurn.executionId,
        attemptId: savedTurn.attemptId,
        idempotencyKey: savedTurn.idempotencyKey,
        providerId: savedTurn.providerId,
        phase: "completed",
        metadata: {
          eventId: event.id,
          commitStatus: commit.status,
          sendState: "COMMITTED",
          replyPath,
          recovery,
        },
      });
    }
    const completedPlan = session.plans.find((candidate) => candidate.id === savedPlan.id);
    const completedTurn = completedPlan?.turns.find((candidate) => candidate.id === savedTurn.id) || savedTurn;
    this.emit("turn.completed", {
      sessionId: session.id,
      planId: savedPlan.id,
      runId: options.runId || null,
      turn: completedTurn,
      recovery,
      qualityFlags: quality.flags,
    });
    return session;
  }

  async persistTurnPass(session, plan, turn, result, options) {
    const completedAt = new Date().toISOString();
    session = await this.store.updateSession(session.id, (current) => {
      const savedPlan = current.plans.find((candidate) => candidate.id === plan.id);
      const savedTurn = savedPlan?.turns.find((candidate) => candidate.id === turn.id);
      if (!savedPlan || !savedTurn) throw new Error("TURN_NOT_FOUND");
      Object.assign(savedTurn, turn, {
        status: "passed",
        participation: "passed",
        completedAt,
        replyPath: null,
        capture: result.capture || null,
        error: null,
      });
      applySeatProjection(current, {
        providerId: savedTurn.providerId,
        throughEventIndex: savedTurn.contextProjection?.throughEventIndex ?? current.events.length - 1,
        sync: savedTurn.contextProjection?.sync,
      }, {
        promptChars: String(savedTurn.prompt || "").length,
        replyChars: 0,
      });
      upsertExecutionIndex(current, executionRecordFromTurn(current, savedPlan, savedTurn));
      current.updatedAt = completedAt;
      return current;
    });
    const savedPlan = session.plans.find((candidate) => candidate.id === plan.id);
    const savedTurn = savedPlan.turns.find((candidate) => candidate.id === turn.id);
    await this.store.appendAudit({
      kind: "turn_passed",
      sessionId: session.id,
      planId: plan.id,
      turnId: turn.id,
      providerId: turn.providerId,
      at: completedAt,
    });
    if (savedTurn.executionId) {
      session = await this.upsertExecutionCheckpoint({
        sessionId: session.id,
        planId: savedPlan.id,
        turnId: savedTurn.id,
        executionId: savedTurn.executionId,
        attemptId: savedTurn.attemptId,
        idempotencyKey: savedTurn.idempotencyKey,
        providerId: savedTurn.providerId,
        phase: "completed",
        metadata: { participation: "passed", sendState: "COMMITTED" },
      });
    }
    this.emit("turn.passed", { sessionId: session.id, planId: savedPlan.id, runId: options.runId || null, turn: savedTurn });
    return session;
  }

  async persistTurnFailure(session, plan, turn, error, options) {
    session = await this.store.updateSession(session.id, (current) => {
      const savedPlan = current.plans.find((candidate) => candidate.id === plan.id);
      const savedTurn = savedPlan?.turns.find((candidate) => candidate.id === turn.id);
      if (!savedPlan || !savedTurn) throw new Error("TURN_NOT_FOUND");
      Object.assign(savedTurn, turn, {
        status: "failed",
        failedAt: new Date().toISOString(),
        error: serializeError(error),
      });
      upsertExecutionIndex(current, executionRecordFromTurn(current, savedPlan, savedTurn));
      current.updatedAt = savedTurn.failedAt;
      return current;
    });
    const savedPlan = session.plans.find((candidate) => candidate.id === plan.id);
    const savedTurn = savedPlan.turns.find((candidate) => candidate.id === turn.id);
    this.emit("turn.failed", {
      sessionId: session.id,
      planId: plan.id,
      runId: options.runId || null,
      turn: savedTurn,
      error: savedTurn.error,
    });
    return this.store.readSession(session.id);
  }

  async persistTurnAbsence(session, plan, turn, error, options) {
    session = await this.store.updateSession(session.id, (current) => {
      const savedPlan = current.plans.find((candidate) => candidate.id === plan.id);
      const savedTurn = savedPlan?.turns.find((candidate) => candidate.id === turn.id);
      if (!savedPlan || !savedTurn) throw new Error("TURN_NOT_FOUND");
      Object.assign(savedTurn, turn, {
        status: "absent",
        failedAt: new Date().toISOString(),
        error: serializeError(error),
      });
      upsertExecutionIndex(current, executionRecordFromTurn(current, savedPlan, savedTurn));
      current.updatedAt = savedTurn.failedAt;
      return current;
    });
    const savedPlan = session.plans.find((candidate) => candidate.id === plan.id);
    const savedTurn = savedPlan.turns.find((candidate) => candidate.id === turn.id);
    const label = getProviderLabel(savedTurn.providerId, session.participants);
    const event = {
      id: randomUUID(),
      type: "absence",
      providerId: savedTurn.providerId,
      content: `${label} 本轮缺席：${savedTurn.error.code} - ${savedTurn.error.message}`,
      commandId: savedPlan.id,
      round: savedTurn.round,
      metadata: {
        placeholder: true,
        technicalFailure: isTechnicalFailure(error),
        error: savedTurn.error,
        attemptId: savedTurn.attemptId,
        idempotencyKey: savedTurn.idempotencyKey,
        sendState: savedTurn.sendState || "NOT_SENT",
        turnId: savedTurn.id,
        sequence: savedTurn.sequence || null,
        role: savedTurn.role,
        stage: savedTurn.stage,
        sideEffectsAllowed: false,
      },
      createdAt: new Date().toISOString(),
    };
    session = await this.store.appendEvents(session.id, [event]);
    this.emit("turn.absent", {
      sessionId: session.id,
      planId: savedPlan.id,
      runId: options.runId || null,
      turn: savedTurn,
      error: savedTurn.error,
    });
    return session;
  }

  async recoverTurn(sessionId, planId, turnId, initialError, options) {
    if (!options.runId || !this.runRegistry) throw initialError;
    let error = initialError;
    while (true) {
      const serialized = serializeError(error);
      const recoveryPromise = this.runRegistry.waitForRecovery(options.runId, { id: turnId }, error);
      let session = await this.store.updateSession(sessionId, (current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === planId);
        const currentTurn = currentPlan?.turns.find((candidate) => candidate.id === turnId);
        if (!currentPlan || !currentTurn) throw new Error("TURN_NOT_FOUND");
        const waitingAt = new Date().toISOString();
        currentTurn.status = "waiting_recovery";
        currentTurn.error = serialized;
        currentPlan.status = "waiting_recovery";
        current.runtime = {
          ...(current.runtime || {}),
          status: "waiting_recovery",
          activePlanId: planId,
          activeRunId: options.runId,
          failedTurnId: turnId,
          error: serialized,
        };
        current.updatedAt = waitingAt;
        return current;
      });
      const waitingPlan = session.plans.find((candidate) => candidate.id === planId);
      const waitingTurn = waitingPlan.turns.find((candidate) => candidate.id === turnId);
      this.emit("turn.waiting_recovery", {
        sessionId,
        planId,
        runId: options.runId,
        turn: waitingTurn,
        error: waitingTurn.error,
      });
      const recovery = await recoveryPromise;
      await this.checkpoint(options);
      let exhausted = null;
      session = await this.store.updateSession(sessionId, (current) => {
        const currentPlan = current.plans.find((candidate) => candidate.id === planId);
        const currentTurn = currentPlan?.turns.find((candidate) => candidate.id === turnId);
        if (!currentPlan || !currentTurn) throw new Error("TURN_NOT_FOUND");
        const resumedAt = new Date().toISOString();
        currentPlan.status = "running";
        current.runtime = {
          ...(current.runtime || {}),
          status: "running",
          activePlanId: planId,
          activeRunId: options.runId,
          failedTurnId: null,
          error: null,
        };
        if (recovery.action === "skip") {
          currentTurn.status = "skipped";
          currentTurn.skippedAt = resumedAt;
          currentTurn.recovery = "skip";
          currentTurn.error = null;
        } else if (recovery.action === "manual") {
          currentTurn.status = "running";
          currentTurn.recovery = "manual";
          currentTurn.error = null;
        } else {
          const recoveryRetryLimit = Math.max(3, Number(current.settings.retryLimit) || 0);
          currentTurn.recoveryAttempts = currentTurn.recoveryAttempts || 0;
          if (currentTurn.recoveryAttempts >= recoveryRetryLimit) {
            exhausted = new AutomationError(
              "RECOVERY_EXHAUSTED",
              `${currentTurn.providerLabel} exhausted ${recoveryRetryLimit} recovery retries.`,
              { providerId: currentTurn.providerId, recoveryRetryLimit },
            );
            currentTurn.status = "failed";
            currentTurn.failedAt = resumedAt;
            currentTurn.error = serializeError(exhausted);
          } else {
            currentTurn.recoveryAttempts += 1;
            this.markTurnRunning(currentTurn, { reuseExecutionId: Boolean(recovery.reuseExecutionId) });
            currentTurn.recovery = "retry";
          }
        }
        current.updatedAt = resumedAt;
        return current;
      });
      const refreshedPlan = session.plans.find((candidate) => candidate.id === planId);
      const refreshedTurn = refreshedPlan.turns.find((candidate) => candidate.id === turnId);
      if (recovery.action === "skip") {
        this.emit("turn.skipped", { sessionId, planId, runId: options.runId, turn: refreshedTurn });
        return session;
      }
      if (recovery.action === "manual") {
        return this.persistTurnSuccess(
          session,
          refreshedPlan,
          refreshedTurn,
          { text: recovery.content, capture: { manual: true, capturedAt: new Date().toISOString() } },
          options,
          "manual",
        );
      }
      if (exhausted) {
        this.emit("turn.failed", {
          sessionId,
          planId,
          runId: options.runId,
          turn: refreshedTurn,
          error: refreshedTurn.error,
        });
        throw exhausted;
      }
      this.emit("turn.started", { sessionId, planId, runId: options.runId, turn: refreshedTurn, recovery: "retry" });
      try {
        const result = await this.executeProvider(session, refreshedPlan, refreshedTurn, options);
        const resultFailure = technicalFailureForResult(result);
        if (resultFailure) throw resultFailure;
        return this.persistTurnSuccess(session, refreshedPlan, refreshedTurn, result, options, "retry");
      } catch (retryError) {
        error = technicalFailureForResult(null, retryError);
        session = await this.store.updateSession(sessionId, (current) => {
          const currentPlan = current.plans.find((candidate) => candidate.id === planId);
          const currentTurn = currentPlan?.turns.find((candidate) => candidate.id === turnId);
          if (!currentPlan || !currentTurn) throw new Error("TURN_NOT_FOUND");
          const failedAt = new Date().toISOString();
          Object.assign(currentTurn, refreshedTurn, {
            status: "failed",
            failedAt,
            error: serializeError(error),
          });
          current.updatedAt = failedAt;
          return current;
        });
        const failedPlan = session.plans.find((candidate) => candidate.id === planId);
        const failedTurn = failedPlan.turns.find((candidate) => candidate.id === turnId);
        this.emit("turn.failed", {
          sessionId,
          planId,
          runId: options.runId,
          turn: failedTurn,
          error: failedTurn.error,
        });
      }
    }
  }

  async mergeLatestTurnState(sessionId, sourcePlan, sourceTurn) {
    return this.store.updateSession(sessionId, (latest) => {
      const latestPlan = latest.plans.find((candidate) => candidate.id === sourcePlan.id);
      const latestTurn = latestPlan?.turns.find((candidate) => candidate.id === sourceTurn.id);
      if (!latestPlan || !latestTurn) throw new Error("TURN_NOT_FOUND");
      Object.assign(latestTurn, sourceTurn);
      for (const key of ["effectiveClosureProviderId", "closureFallback", "writeExecutorId"]) {
        if (sourcePlan[key] !== undefined) latestPlan[key] = sourcePlan[key];
      }
      latest.updatedAt = new Date().toISOString();
      return latest;
    });
  }

  async withExecutionCheckpointLock(sessionId, operation) {
    const previous = this.executionCheckpointLocks.get(sessionId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.executionCheckpointLocks.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.executionCheckpointLocks.get(sessionId) === current) {
        this.executionCheckpointLocks.delete(sessionId);
      }
    }
  }

  async upsertExecutionCheckpoint({
    sessionId,
    planId,
    turnId,
    executionId,
    attemptId = null,
    idempotencyKey = null,
    providerId,
    phase,
    metadata = {},
  }) {
    if (!executionId) throw new Error("EXECUTION_ID_REQUIRED");
    const normalizedPhase = String(phase || "").trim().toLowerCase();
    if (!normalizedPhase) throw new Error("CHECKPOINT_PHASE_REQUIRED");
    return this.withExecutionCheckpointLock(sessionId, async () => {
      return this.store.updateSession(sessionId, (session) => {
        const plan = session.plans.find((candidate) => candidate.id === planId);
        const turn = plan?.turns.find((candidate) => candidate.id === turnId);
        if (!plan || !turn) throw new Error("TURN_NOT_FOUND");
        const now = new Date().toISOString();
        const safeMetadata = cloneCheckpointMetadata(metadata);
        const checkpoints = [...(session.checkpoints || [])];
        const index = checkpoints.findIndex((candidate) => candidate.executionId === executionId);
        const existing = index >= 0 ? checkpoints[index] : null;
        const history = [...(existing?.history || [])];
        const lastHistory = history.at(-1);
        if (lastHistory?.phase === normalizedPhase) {
          history[history.length - 1] = {
            ...lastHistory,
            metadata: { ...(lastHistory.metadata || {}), ...safeMetadata },
          };
        } else {
          history.push({ phase: normalizedPhase, at: now, metadata: safeMetadata });
        }
        const checkpoint = {
          ...(existing || {}),
          executionId,
          attemptId: attemptId || existing?.attemptId || turn.attemptId || null,
          idempotencyKey: idempotencyKey || existing?.idempotencyKey || turn.idempotencyKey || null,
          sessionId,
          planId,
          turnId,
          providerId,
          phase: normalizedPhase,
          metadata: { ...(existing?.metadata || {}), ...safeMetadata },
          history,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        const phaseTimestamp = `${normalizedPhase}At`;
        checkpoint[phaseTimestamp] = checkpoint[phaseTimestamp] || now;
        if (index >= 0) checkpoints[index] = checkpoint;
        else checkpoints.push(checkpoint);
        session.checkpoints = checkpoints;
        turn.executionId = executionId;
        turn.executionPhase = normalizedPhase;
        turn.sendState = safeMetadata.sendState || sendStateForPhase(normalizedPhase, turn.sendState || "NOT_SENT");
        turn.executionCheckpointAt = now;
        session.executionIndex = (session.executionIndex || []).map((record) =>
          record.turnId === turn.id && record.executionId !== executionId && record.status === "running"
            ? { ...record, status: "superseded", updatedAt: now }
            : record
        );
        upsertExecutionIndex(session, {
          ...executionRecordFromTurn(session, plan, turn, checkpoint),
          status: turn.status,
          updatedAt: now,
        });
        session.updatedAt = now;
        return session;
      });
    });
  }

  async executeProvider(session, plan, turn, options) {
    const checkpointBase = {
      sessionId: session.id,
      planId: plan.id,
      turnId: turn.id,
      executionId: turn.executionId,
      attemptId: turn.attemptId,
      idempotencyKey: turn.idempotencyKey,
      providerId: turn.providerId,
    };
    const resumingExecution = Boolean(turn.resumingExecution && turn.executionId);
    turn.resumingExecution = false;
    if (!resumingExecution) {
      turn.executionPhase = "prepared";
      await this.upsertExecutionCheckpoint({
        ...checkpointBase,
        phase: "prepared",
        metadata: {
          role: turn.role,
          round: turn.round,
          stage: turn.stage,
          threadKey: session.threads?.[turn.providerId]?.threadKey || null,
          attemptId: turn.attemptId,
          idempotencyKey: turn.idempotencyKey,
          sendState: turn.sendState || "NOT_SENT",
        },
      });
    }
    if (session.settings.mode === "mock") return { text: buildMockReply(session, plan, turn) };
    if (!this.worker?.execute) throw new Error("BROWSER_WORKER_UNAVAILABLE");
    const paths = this.store.getSessionPaths(session.id);
    return this.worker.execute({
      sessionId: session.id,
      planId: plan.id,
      turnId: turn.id,
      executionId: turn.executionId,
      attemptId: turn.attemptId,
      idempotencyKey: turn.idempotencyKey,
      runId: options.runId || null,
      providerId: turn.providerId,
      writeExecutorId: writeExecutorForTurn(plan, turn),
      threadKey: session.threads?.[turn.providerId]?.threadKey || null,
      prompt: turn.prompt,
      round: turn.round,
      sequence: turn.sequence || null,
      role: turn.role,
      stage: turn.stage,
      attempt: turn.providerAttempts?.[turn.providerId] || 1,
      sendState: turn.sendState || "NOT_SENT",
      contextEventIndex: turn.contextProjection?.throughEventIndex ?? null,
      timeoutMs: session.settings.executionTimeoutMs,
      settleMs: session.settings.settleMs,
      autoSend: session.settings.autoSend,
      autoCapture: session.settings.autoCapture,
      diagnosticsDir: paths.diagnostics,
      signal: options.signal,
      onCaptureStart: async (metadata = {}) => {
        turn.sendState = "CAPTURING";
        await this.upsertExecutionCheckpoint({
          ...checkpointBase,
          phase: "submitted",
          metadata: {
            ...metadata,
            sendState: "CAPTURING",
            attemptId: turn.attemptId,
            idempotencyKey: turn.idempotencyKey,
          },
        });
      },
      onProgress: async (snapshot = {}) => {
        const text = String(snapshot.text || "").trim();
        if (!text) return;
        const progressTail = tailWindowForProgress(text);
        this.emit("turn.progress", {
          sessionId: session.id,
          planId: plan.id,
          runId: options.runId || null,
          turnId: turn.id,
          executionId: turn.executionId,
          providerId: turn.providerId,
          providerLabel: turn.providerLabel || getProviderLabel(turn.providerId, session.participants),
          round: turn.round,
          stage: turn.stage,
          text: progressTail.text,
          progressTruncated: progressTail.truncated,
          progressTotalChars: progressTail.totalChars,
          at: snapshot.at || new Date().toISOString(),
        });
      },
      checkpoint: async (phase, metadata = {}) => {
        turn.executionPhase = String(phase || "").trim().toLowerCase();
        turn.sendState = metadata.sendState || sendStateForPhase(turn.executionPhase, turn.sendState || "NOT_SENT");
        const saved = await this.upsertExecutionCheckpoint({
          ...checkpointBase,
          phase,
          metadata: {
            ...metadata,
            attemptId: turn.attemptId,
            idempotencyKey: turn.idempotencyKey,
            sendState: turn.sendState,
          },
        });
        turn.executionCheckpointAt = saved.plans
          .find((candidate) => candidate.id === plan.id)
          ?.turns.find((candidate) => candidate.id === turn.id)
          ?.executionCheckpointAt || null;
      },
    });
  }

  createRawReplyEvent(session, plan, turn, content, recovery, replyIdentity) {
    return {
      id: randomUUID(),
      type: "reply.raw_captured",
      providerId: turn.providerId,
      content,
      commandId: plan.id,
      round: turn.round,
      metadata: {
        visibility: "private",
        lifecycle: "raw_captured",
        turnId: turn.id,
        role: turn.role,
        stage: turn.stage,
        recovery,
        replyIdentity,
      },
      createdAt: new Date().toISOString(),
    };
  }

  createValidatedReplyEvent(session, plan, turn, content, recovery, quality, structured, replyIdentity, commit) {
    return {
      id: randomUUID(),
      type: "reply.validated",
      providerId: turn.providerId,
      content: "",
      commandId: plan.id,
      round: turn.round,
      metadata: {
        visibility: "private",
        lifecycle: "validated",
        turnId: turn.id,
        role: turn.role,
        stage: turn.stage,
        recovery,
        replyIdentity,
        structureStatus: structured.status,
        structureErrors: structured.errors,
        qualityFlags: quality?.flags || [],
        commitStatus: commit.status,
        commitReason: commit.reason,
      },
      createdAt: new Date().toISOString(),
    };
  }

  createReplyEvent(session, plan, turn, content, recovery = null, quality = null, structuredReply = null, structureStatus = "unknown", replyIdentity = null, commit = { status: "committed", reason: "legacy" }) {
    return {
      id: randomUUID(),
      type: "reply",
      providerId: turn.providerId,
      content,
      commandId: plan.id,
      round: turn.round,
      metadata: {
        executionMode: session.settings.mode,
        conversationMode: plan.conversationMode,
        turnId: turn.id,
        sequence: turn.sequence || null,
        role: turn.role,
        stage: turn.stage,
        visibleClosure: isClosureTurn(turn),
        countsTowardRounds: turn.countsTowardRounds,
        replyPath: turn.replyPath || null,
        recovery,
        qualityFlags: quality?.flags || [],
        confidence: quality?.confidence || "candidate",
        structureStatus,
        structuredReply,
        verified: false,
        sideEffectsAllowed: quality?.sideEffectsAllowed ?? true,
        replyIdentity,
        replyRelations: turn.replyRelations || [],
        lifecycle: commit.status === "committed" ? "committed" : "rejected",
        commitStatus: commit.status,
        commitReason: commit.reason,
        visibility: commit.status === "committed" ? "public" : "private",
        lifecycleTrace: ["raw_captured", "validated", commit.status === "committed" ? "committed" : "rejected"],
        contextEventIndex: turn.contextProjection?.throughEventIndex ?? null,
        fallbackFromProviderId: turn.fallbackFromProviderId || null,
        fallbackReason: turn.fallbackReason || null,
      },
      createdAt: new Date().toISOString(),
    };
  }
}

export { buildMockReply, serializeError };
