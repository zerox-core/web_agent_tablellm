import { randomUUID } from "node:crypto";

import { DEFAULT_SETTINGS } from "../core/providers.mjs";
import { estimatePromptTokens as defaultEstimatePromptTokens, estimateTextTokens } from "./context-token-estimator.mjs";
import { isContextEvent } from "./reply-lifecycle.mjs";

const COMPRESSION_SCHEMA = "web-agents-roundtable-compression.v1";
const BUCKETS = ["consensus", "disagreements", "evidence", "decisions", "unclassified"];
const MARKERS = new Map([
  ["共识", "consensus"],
  ["分歧", "disagreements"],
  ["证据", "evidence"],
  ["决定", "decisions"],
  ["决策", "decisions"],
]);
const DERIVED_COMPRESSION_FIELDS = Object.freeze([
  ["summary", "unclassified", "核心判断"],
  ["claims", "unclassified", "主张"],
  ["evidence", "evidence", ""],
  ["risks", "unclassified", "风险"],
  ["disagreements", "disagreements", ""],
  ["actions", "unclassified", "行动"],
  ["missingEvidence", "unclassified", "信息缺口"],
]);

function compressionError(code) {
  return Object.assign(new Error(code), { code });
}

function timestamp(value) {
  return typeof value === "function" ? value() : value || new Date().toISOString();
}

function compactText(value, maximum = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1)}…`;
}

function settingsFor(session, providerId) {
  const settings = session?.settings || {};
  const providerOverrides = settings.providerContextWindowTokens || {};
  const providerWindow = providerId ? Number(providerOverrides[providerId]) : Number.NaN;
  const windowTokens = Number.isFinite(providerWindow) && providerWindow > 0
    ? Math.floor(providerWindow)
    : Number(settings.contextWindowTokens || DEFAULT_SETTINGS.contextWindowTokens);
  const triggerPercent = Number(settings.compressionTriggerPercent || DEFAULT_SETTINGS.compressionTriggerPercent);
  const targetPercent = Number(settings.compressionTargetPercent || DEFAULT_SETTINGS.compressionTargetPercent);
  return {
    windowTokens,
    triggerPercent,
    targetPercent,
    triggerTokens: Math.floor((windowTokens * triggerPercent) / 100),
    targetTokens: Math.floor((windowTokens * targetPercent) / 100),
    recentRawTokenBudget: Number(settings.recentRawTokenBudget || DEFAULT_SETTINGS.recentRawTokenBudget),
  };
}

function recentRawStartIndex(events, tokenBudget, estimateEventTokens) {
  let total = 0;
  let start = events.length;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const eventTokens = Math.max(1, Number(estimateEventTokens(events[index])) || 1);
    if (start < events.length && total + eventTokens > tokenBudget) break;
    total += eventTokens;
    start = index;
  }
  return start;
}

function markerEntry(event, eventIndex) {
  const match = String(event?.content || "").match(/^\s*(共识|分歧|证据|决定|决策)\s*[：:]\s*(.+?)\s*$/s);
  if (!match) return null;
  const bucket = MARKERS.get(match[1]);
  const text = compactText(match[2], 320);
  if (!bucket || !text) return null;
  return {
    bucket,
    entry: {
      id: `${bucket}:${event.id || eventIndex}`,
      text,
      sourceEventIds: [String(event.id)],
    },
  };
}

function derivedEntries(event, eventIndex) {
  const status = event?.metadata?.structureStatus;
  const reply = event?.metadata?.structuredReply;
  if (!["valid", "recovered"].includes(status) || !reply || typeof reply !== "object") return [];
  const sourceEventId = String(event.id || eventIndex);
  const entries = [];
  for (const [field, bucket, label] of DERIVED_COMPRESSION_FIELDS) {
    const rawValues = field === "summary" ? [reply[field]] : reply[field];
    if (!Array.isArray(rawValues)) continue;
    rawValues.forEach((value, itemIndex) => {
      const text = compactText(value, 320);
      if (!text) return;
      entries.push({
        bucket,
        entry: {
          id: `${bucket}:${sourceEventId}:${field}:${itemIndex}`,
          text: label ? `${label}：${text}` : text,
          sourceEventIds: [sourceEventId],
        },
      });
    });
  }
  return entries;
}

function emptyBuckets() {
  return Object.fromEntries(BUCKETS.map((bucket) => [bucket, []]));
}

function cloneBuckets(revision) {
  return Object.fromEntries(BUCKETS.map((bucket) => [bucket, structuredClone(revision?.[bucket] || [])]));
}

function appendCoveredEvents(buckets, events, fromIndex, throughIndex) {
  for (let index = fromIndex; index <= throughIndex; index += 1) {
    const event = events[index];
    if (!event?.id || !isContextEvent(event)) continue;
    const marked = markerEntry(event, index);
    if (marked) {
      buckets[marked.bucket].push(marked.entry);
      continue;
    }
    const derived = derivedEntries(event, index);
    if (derived.length) {
      for (const item of derived) buckets[item.bucket].push(item.entry);
      continue;
    }
    buckets.unclassified.push({
      id: `unclassified:${event.id}`,
      text: compactText(event.content),
      sourceEventIds: [String(event.id)],
    });
  }
}

function revisionMetrics(active, droppedUnclassifiedEntryCount) {
  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, (active?.[bucket] || []).length]));
  const classifiedEntryCount = counts.consensus + counts.disagreements + counts.evidence + counts.decisions;
  const unclassifiedEntryCount = counts.unclassified;
  const entryCount = classifiedEntryCount + unclassifiedEntryCount;
  return {
    entryCount,
    classifiedEntryCount,
    unclassifiedEntryCount,
    classifiedShare: entryCount ? Math.round((classifiedEntryCount / entryCount) * 100) / 100 : 0,
    disagreementEntryCount: counts.disagreements,
    droppedUnclassifiedEntryCount,
  };
}

function stateWithRevision(previousState, revision) {
  const revisions = [...(previousState?.revisions || []), structuredClone(revision)];
  return {
    schema: COMPRESSION_SCHEMA,
    activeRevision: revision.revision,
    active: structuredClone(revision),
    revisions,
    lastError: null,
  };
}

function rebuildEstimate(session, state, buildPrompt, estimatePromptTokens, targetTokens) {
  session.context.compression = state;
  const afterTokens = estimatePromptTokens(buildPrompt(session));
  state.active.estimate.afterTokens = afterTokens;
  state.active.estimate.targetMet = afterTokens <= targetTokens;
  state.revisions[state.revisions.length - 1] = structuredClone(state.active);
  return afterTokens;
}

export function getActiveCompression(session) {
  return session?.context?.compression?.active || null;
}

export function compressSessionContext(session, options = {}) {
  const events = Array.isArray(session?.events) ? session.events : [];
  const estimatePrompt = options.estimatePromptTokens || defaultEstimatePromptTokens;
  const estimateEvent = options.estimateEventTokens || ((event) => estimateTextTokens(event?.content || ""));
  const prompt = String(options.prompt || "");
  const providerId = options.providerId ? String(options.providerId) : null;
  const budget = settingsFor(session, providerId);
  const beforeTokens = estimatePrompt(prompt);
  const active = getActiveCompression(session);

  if (beforeTokens < budget.triggerTokens) {
    return { changed: false, reason: "below_trigger", compression: active, estimate: { beforeTokens, ...budget } };
  }

  const recentStart = recentRawStartIndex(events, budget.recentRawTokenBudget, estimateEvent);
  const coveredThroughEventIndex = recentStart - 1;
  if (coveredThroughEventIndex < 0) {
    return { changed: false, reason: "insufficient_history", compression: active, estimate: { beforeTokens, ...budget } };
  }
  if (active && active.coveredThroughEventIndex >= coveredThroughEventIndex) {
    return { changed: false, reason: "boundary_unchanged", compression: active, estimate: { beforeTokens, ...budget } };
  }

  session.context = session.context && typeof session.context === "object" ? session.context : {};
  const previousState = session.context.compression || null;
  const buckets = active ? cloneBuckets(active) : emptyBuckets();
  const coveredFromEventIndex = active ? active.coveredFromEventIndex : 0;
  const appendFromIndex = active ? active.coveredThroughEventIndex + 1 : 0;
  appendCoveredEvents(buckets, events, appendFromIndex, coveredThroughEventIndex);

  const revisionNumber = Number(active?.revision || 0) + 1;
  const revision = {
    id: (options.idFactory || randomUUID)(),
    revision: revisionNumber,
    createdAt: timestamp(options.now),
    reason: "automatic",
    providerId,
    coveredFromEventIndex,
    coveredThroughEventIndex,
    sourceEventIds: events
      .slice(coveredFromEventIndex, coveredThroughEventIndex + 1)
      .filter(isContextEvent)
      .map((event) => String(event.id))
      .filter(Boolean),
    ...buckets,
    estimate: {
      beforeTokens,
      afterTokens: null,
      windowTokens: budget.windowTokens,
      triggerTokens: budget.triggerTokens,
      targetTokens: budget.targetTokens,
      targetMet: false,
    },
  };
  const state = stateWithRevision(previousState, revision);
  const buildPrompt = options.buildPrompt || (() => JSON.stringify(state.active));
  let afterTokens = rebuildEstimate(session, state, buildPrompt, estimatePrompt, budget.targetTokens);
  let droppedUnclassifiedEntryCount = 0;
  while (afterTokens > budget.targetTokens && state.active.unclassified.length > 0) {
    state.active.unclassified.pop();
    droppedUnclassifiedEntryCount += 1;
    afterTokens = rebuildEstimate(session, state, buildPrompt, estimatePrompt, budget.targetTokens);
  }
  state.active.metrics = revisionMetrics(state.active, droppedUnclassifiedEntryCount);
  state.revisions[state.revisions.length - 1] = structuredClone(state.active);

  return { changed: true, reason: "compressed", compression: state.active, state };
}

function normalizedEntries(values, bucket, knownEventIds, entryIds) {
  if (!Array.isArray(values)) throw compressionError("INVALID_COMPRESSION_BUCKET");
  return values.map((value, index) => {
    const id = String(value?.id || `${bucket}:user:${index}`).trim();
    const text = String(value?.text || "").trim();
    const sourceEventIds = Array.isArray(value?.sourceEventIds)
      ? [...new Set(value.sourceEventIds.map((eventId) => String(eventId).trim()).filter(Boolean))]
      : [];
    if (!id || !text || sourceEventIds.length === 0) throw compressionError("INVALID_COMPRESSION_ENTRY");
    if (entryIds.has(id)) throw compressionError("DUPLICATE_COMPRESSION_ENTRY");
    entryIds.add(id);
    for (const sourceEventId of sourceEventIds) {
      if (!knownEventIds.has(sourceEventId)) throw compressionError("UNKNOWN_COMPRESSION_SOURCE_EVENT");
    }
    return { id, text, sourceEventIds };
  });
}

export function reviseSessionCompression(session, payload = {}, options = {}) {
  const active = getActiveCompression(session);
  if (!active) throw compressionError("COMPRESSION_NOT_FOUND");
  if (Number(payload.baseRevision) !== Number(active.revision)) {
    throw compressionError("STALE_COMPRESSION_REVISION");
  }

  const knownEventIds = new Set((session.events || []).map((event) => String(event.id)));
  const entryIds = new Set();
  const buckets = {};
  for (const bucket of BUCKETS) {
    buckets[bucket] = normalizedEntries(payload[bucket] ?? active[bucket] ?? [], bucket, knownEventIds, entryIds);
  }

  const revision = {
    ...structuredClone(active),
    id: (options.idFactory || randomUUID)(),
    revision: Number(active.revision) + 1,
    createdAt: timestamp(options.now),
    reason: "user_revision",
    ...buckets,
  };
  revision.metrics = revisionMetrics(revision, 0);
  const state = stateWithRevision(session.context.compression, revision);
  session.context.compression = state;
  return state.active;
}

function requireCompressionState(session) {
  const state = session?.context?.compression;
  if (!state?.active) throw compressionError("COMPRESSION_NOT_FOUND");
  return state;
}

function revisionByNumber(state, revisionNumber) {
  const target = Number(revisionNumber);
  if (!Number.isFinite(target) || target < 1) throw compressionError("INVALID_COMPRESSION_REVISION");
  const revision = (state.revisions || []).find((candidate) => Number(candidate.revision) === target);
  if (!revision) throw compressionError("COMPRESSION_REVISION_NOT_FOUND");
  return revision;
}

export function diffCompressionRevisions(session, payload = {}) {
  const state = requireCompressionState(session);
  const toRevision = revisionByNumber(state, payload.to ?? state.active.revision);
  const fromRevision = revisionByNumber(state, payload.from ?? Number(toRevision.revision) - 1);
  const buckets = {};
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  for (const bucket of BUCKETS) {
    const before = new Map((fromRevision[bucket] || []).map((entry) => [entry.id, entry]));
    const after = new Map((toRevision[bucket] || []).map((entry) => [entry.id, entry]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [id, entry] of after) {
      const previous = before.get(id);
      if (!previous) {
        added.push({ id, text: entry.text, sourceEventIds: [...entry.sourceEventIds] });
        addedCount += 1;
      } else if (previous.text !== entry.text) {
        changed.push({ id, fromText: previous.text, toText: entry.text, sourceEventIds: [...entry.sourceEventIds] });
        changedCount += 1;
      }
    }
    for (const [id, entry] of before) {
      if (!after.has(id)) {
        removed.push({ id, text: entry.text, sourceEventIds: [...entry.sourceEventIds] });
        removedCount += 1;
      }
    }
    buckets[bucket] = { added, removed, changed };
  }
  return {
    schema: COMPRESSION_SCHEMA,
    from: { revision: fromRevision.revision, id: fromRevision.id },
    to: { revision: toRevision.revision, id: toRevision.id },
    counts: { added: addedCount, removed: removedCount, changed: changedCount },
    buckets,
  };
}

export function rollbackCompressionFields(session, payload = {}, options = {}) {
  const state = requireCompressionState(session);
  const active = state.active;
  if (Number(payload.baseRevision) !== Number(active.revision)) {
    throw compressionError("STALE_COMPRESSION_REVISION");
  }
  const targetRevision = revisionByNumber(state, payload.targetRevision);
  if (Number(targetRevision.revision) === Number(active.revision)) {
    throw compressionError("INVALID_COMPRESSION_REVISION");
  }
  const fields = [...new Set((Array.isArray(payload.fields) ? payload.fields : []).map((field) => String(field)))];
  if (fields.length === 0 || fields.some((field) => !BUCKETS.includes(field))) {
    throw compressionError("INVALID_COMPRESSION_FIELDS");
  }
  const knownEventIds = new Set((session.events || []).map((event) => String(event.id)));
  const entryIds = new Set();
  const buckets = {};
  for (const bucket of BUCKETS) {
    const source = fields.includes(bucket) ? targetRevision : active;
    buckets[bucket] = normalizedEntries(source[bucket] ?? [], bucket, knownEventIds, entryIds);
  }
  const revision = {
    ...structuredClone(active),
    id: (options.idFactory || randomUUID)(),
    revision: Number(active.revision) + 1,
    createdAt: timestamp(options.now),
    reason: "field_rollback",
    rollback: { targetRevision: Number(targetRevision.revision), fields },
    ...buckets,
  };
  revision.metrics = revisionMetrics(revision, 0);
  const nextState = stateWithRevision(state, revision);
  session.context.compression = nextState;
  return nextState.active;
}

const ANNOTATION_NOTE_MAX_LENGTH = 2000;

export function annotateCompressionRevision(session, payload = {}, options = {}) {
  const state = requireCompressionState(session);
  const revision = revisionByNumber(state, payload.revision ?? state.active.revision);
  const note = String(payload.note ?? "").trim();
  if (!note || note.length > ANNOTATION_NOTE_MAX_LENGTH) {
    throw compressionError("INVALID_COMPRESSION_NOTE");
  }
  const annotation = {
    id: (options.annotationIdFactory || randomUUID)(),
    note,
    createdAt: timestamp(options.now),
  };
  revision.annotations = [...(revision.annotations || []), structuredClone(annotation)];
  if (Number(state.active.revision) === Number(revision.revision)) {
    state.active.annotations = structuredClone(revision.annotations);
  }
  return { revision: structuredClone(revision), annotation: structuredClone(annotation) };
}

export const COMPRESSION_BUCKETS = Object.freeze([...BUCKETS]);
export const CONTEXT_COMPRESSION_SCHEMA = COMPRESSION_SCHEMA;
