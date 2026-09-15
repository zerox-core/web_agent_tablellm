import { AutomationError, abortableDelay, throwIfAborted } from "./errors.mjs";
import { createProgressReporter } from "./progress-reporter.mjs";

export function normalizeResponseText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function selectNewResponseCandidate(candidates, baselineCandidates = []) {
  const candidateKey = (candidate, text) => candidate.identity
    ? `${candidate.identity}\u0000${text}`
    : `${candidate.selector || ""}\u0000${candidate.index ?? ""}\u0000${text}`;
  const baseline = new Set(baselineCandidates.map((candidate) => {
    const text = normalizeResponseText(candidate.text);
    return text ? candidateKey(candidate, text) : null;
  }).filter(Boolean));
  const normalized = candidates
    .map((candidate) => ({ ...candidate, text: normalizeResponseText(candidate.text) }))
    .filter((candidate) => candidate.text.length >= 2);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (!baseline.has(candidateKey(normalized[index], normalized[index].text))) return normalized[index];
  }
  return null;
}

const TRANSIENT_PLACEHOLDER_PATTERNS = [
  /^正在思考[…。.]?$/,
  /^思考中[…。.]?$/,
  /^正在深度思考[…。.]?$/,
  /^深度思考中[…。.]?$/,
  /^正在生成(回复)?[中…。.]?$/,
  /^正在回复[…。.]?$/,
  /^正在输入[…。.]?$/,
  /^thinking[….\.]*$/i,
];

export function isTransientPlaceholderText(text) {
  const source = normalizeResponseText(text);
  if (!source) return false;
  return TRANSIENT_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(source));
}
export function responseStructureComplete(text) {
  const source = normalizeResponseText(text);
  const fencedJson = /^```(?:json|jsonl)?\s*/i.test(source);
  const firstBrace = source.indexOf("{");
  if (firstBrace < 0) return !fencedJson;
  if (!fencedJson && source.slice(0, firstBrace).trim()) return true;
  let depth = 0;
  for (let index = firstBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

export async function waitForCompletedResponse({
  page,
  adapter,
  resolvePage = null,
  baselineCandidates = [],
  timeoutMs = 180000,
  settleMs = 3000,
  pollMs = 350,
  progressThrottleMs = 400,
  onProgress,
  signal,
}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let latestText = "";
  let changedAt = 0;
  let observedBusy = false;
  const progressReporter = createProgressReporter({ onProgress, throttleMs: progressThrottleMs });

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const current = resolvePage ? await resolvePage(page) : page;
    await adapter.assertAutomationReady?.(current, { phase: "wait_for_response" });
    const [candidates, busy] = await Promise.all([
      adapter.collectResponseCandidates(current),
      adapter.isBusy(current),
    ]);
    observedBusy ||= busy;
    const candidate = selectNewResponseCandidate(candidates, baselineCandidates);
    if (candidate && candidate.text !== latestText) {
      latest = candidate;
      latestText = candidate.text;
      changedAt = Date.now();
      await progressReporter.report({
        text: latestText,
        selector: candidate.selector,
        index: candidate.index,
        identity: candidate.identity,
      });
    }
    if (latest && !busy && !isTransientPlaceholderText(latestText) && responseStructureComplete(latestText) && Date.now() - changedAt >= settleMs) {
      return {
        ...latest,
        observedBusy,
        settledAt: new Date().toISOString(),
      };
    }
    await abortableDelay(pollMs, signal);
  }

  throw new AutomationError(
    "RESPONSE_TIMEOUT",
    `Timed out waiting for ${adapter.label} response after ${timeoutMs}ms.`,
    { providerId: adapter.id, latestText, observedBusy }
  );
}
