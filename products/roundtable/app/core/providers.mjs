import { randomUUID } from "node:crypto";

export const PROVIDERS = [
  { id: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/", automation: "mvp" },
  { id: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com/", automation: "mvp" },
  { id: "doubao", label: "Dola", url: "https://www.dola.com/chat/", automation: "mvp" },
  { id: "doubao-cn", label: "豆包（国内版）", url: "https://www.doubao.com/chat/", automation: "mvp" },
  { id: "gemini", label: "Gemini", url: "https://gemini.google.com/app", automation: "mvp" },
  { id: "qwen", label: "Qwen", url: "https://chat.qwen.ai/", automation: "planned" },
  { id: "kimi", label: "Kimi", url: "https://www.kimi.com/agent?chat_enter_method=change_model", automation: "mvp" },
  { id: "glm", label: "GLM", url: "https://chat.z.ai/", automation: "mvp" },
  { id: "grok", label: "Grok", url: "https://grok.com/", automation: "planned" },
  { id: "google-ai-studio", label: "Google AI Studio", url: "https://aistudio.google.com/", automation: "planned" },
];

export const PROVIDER_ALIASES = new Map([
  ["gpt", "chatgpt"],
  ["chatgpt", "chatgpt"],
  ["openai", "chatgpt"],
  ["deepseek", "deepseek"],
  ["ds", "deepseek"],
  ["豆包", "doubao"],
  ["doubao", "doubao"],
  ["dola", "doubao"],
  ["doubao-cn", "doubao-cn"],
  ["豆包国内版", "doubao-cn"],
  ["gemini", "gemini"],
  ["qwen", "qwen"],
  ["qwq", "qwen"],
  ["千问", "qwen"],
  ["通义", "qwen"],
  ["kimi", "kimi"],
  ["glm", "glm"],
  ["智谱", "glm"],
  ["zai", "glm"],
  ["grok", "grok"],
  ["aistudio", "google-ai-studio"],
  ["ai-studio", "google-ai-studio"],
  ["google-ai-studio", "google-ai-studio"],
]);

export const ALL_ALIASES = new Set(["all", "全体", "大家", "全部"]);

export const DEFAULT_SETTINGS = Object.freeze({
  defaultRounds: 5,
  conversationMode: "discussion",
  mode: "mock",
  autoSend: true,
  autoCapture: true,
  maxContextEvents: 24,
  recentRawEvents: 6,
  contextWindowTokens: 131072,
  providerContextWindowTokens: {},
  compressionTriggerPercent: 80,
  compressionTargetPercent: 20,
  recentRawTokenBudget: 16384,
  providerConcurrency: 1,
  estimatedThreadCapacityChars: 120000,
  handoffThreshold: 72,
  urgentHandoffThreshold: 90,
  handoffWarningPercent: 72,
  handoffUrgentPercent: 90,
  executionTimeoutMs: 180000,
  settleMs: 3000,
  retryLimit: 1,
  workbenchEnabled: false,
});

export function getProvider(providerId, providers = PROVIDERS) {
  return providers.find((provider) => provider.id === providerId);
}

export function getProviderLabel(providerId, providers = PROVIDERS) {
  if (!providerId) return "用户";
  return getProvider(providerId, providers)?.label || providerId;
}

export function normalizeProviderAlias(value) {
  return String(value || "").trim().toLowerCase();
}

export function resolveProviderAlias(value) {
  const normalized = normalizeProviderAlias(value);
  if (ALL_ALIASES.has(normalized)) return "all";
  return PROVIDER_ALIASES.get(normalized) || normalized;
}

export function getProviderAliases(providerId) {
  return [...PROVIDER_ALIASES.entries()]
    .filter(([, resolved]) => resolved === providerId)
    .map(([alias]) => alias);
}

const UNHEALTHY_PROVIDER_STATUSES = new Set([
  "error",
  "failed",
  "unavailable",
  "offline",
  "disabled",
  "left",
  "login_required",
  "waiting_login",
  "waiting_user",
  "waiting_browser",
  "waiting_verification",
  "verification_required",
  "captcha_required",
  "closed",
]);

export function isProviderHealthy(participant, thread = null) {
  if (!participant || participant.healthy === false || participant.enabled === false) return false;
  const participantStatus = normalizeProviderAlias(participant.status);
  const threadStatus = normalizeProviderAlias(thread?.status);
  return !UNHEALTHY_PROVIDER_STATUSES.has(participantStatus)
    && !UNHEALTHY_PROVIDER_STATUSES.has(threadStatus);
}

export function coerceInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function coerceProviderContextWindowTokens(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const coerced = {};
  for (const [providerId, windowTokens] of Object.entries(value)) {
    const parsed = Number.parseInt(String(windowTokens), 10);
    if (!Number.isInteger(parsed) || parsed < 16384 || parsed > 1000000) continue;
    coerced[providerId] = parsed;
  }
  return coerced;
}

export function coerceSettings(value = {}) {
  const contextWindowTokens = coerceInteger(
    value.contextWindowTokens,
    DEFAULT_SETTINGS.contextWindowTokens,
    16384,
    1000000,
  );
  const compressionTriggerPercent = coerceInteger(
    value.compressionTriggerPercent,
    DEFAULT_SETTINGS.compressionTriggerPercent,
    50,
    95,
  );
  const compressionTargetPercent = Math.min(
    compressionTriggerPercent - 1,
    coerceInteger(
      value.compressionTargetPercent,
      DEFAULT_SETTINGS.compressionTargetPercent,
      10,
      40,
    ),
  );
  const targetTokens = Math.floor((contextWindowTokens * compressionTargetPercent) / 100);
  const providerContextWindowTokens = coerceProviderContextWindowTokens(value.providerContextWindowTokens);
  return {
    defaultRounds: coerceInteger(value.defaultRounds, DEFAULT_SETTINGS.defaultRounds, 2, 10),
    conversationMode: value.conversationMode === "relay" ? "relay" : "discussion",
    mode: value.mode === "extension" ? "extension" : value.mode === "playwright" ? "playwright" : "mock",
    autoSend: value.autoSend === undefined ? DEFAULT_SETTINGS.autoSend : Boolean(value.autoSend),
    autoCapture: value.autoCapture === undefined ? DEFAULT_SETTINGS.autoCapture : Boolean(value.autoCapture),
    maxContextEvents: coerceInteger(value.maxContextEvents, DEFAULT_SETTINGS.maxContextEvents, 4, 120),
    recentRawEvents: coerceInteger(value.recentRawEvents, DEFAULT_SETTINGS.recentRawEvents, 1, 30),
    contextWindowTokens,
    providerContextWindowTokens,
    compressionTriggerPercent,
    compressionTargetPercent,
    recentRawTokenBudget: coerceInteger(
      value.recentRawTokenBudget,
      Math.min(DEFAULT_SETTINGS.recentRawTokenBudget, targetTokens),
      1024,
      targetTokens,
    ),
    providerConcurrency: coerceInteger(
      value.providerConcurrency,
      DEFAULT_SETTINGS.providerConcurrency,
      1,
      10,
    ),
    estimatedThreadCapacityChars: coerceInteger(
      value.estimatedThreadCapacityChars,
      DEFAULT_SETTINGS.estimatedThreadCapacityChars,
      1000,
      10000000,
    ),
    handoffThreshold: coerceInteger(
      value.handoffThreshold ?? value.handoffWarningPercent,
      DEFAULT_SETTINGS.handoffThreshold,
      1,
      99,
    ),
    urgentHandoffThreshold: coerceInteger(
      value.urgentHandoffThreshold ?? value.handoffUrgentPercent,
      DEFAULT_SETTINGS.urgentHandoffThreshold,
      2,
      100,
    ),
    handoffWarningPercent: coerceInteger(
      value.handoffWarningPercent ?? value.handoffThreshold,
      DEFAULT_SETTINGS.handoffWarningPercent,
      1,
      99,
    ),
    handoffUrgentPercent: coerceInteger(
      value.handoffUrgentPercent ?? value.urgentHandoffThreshold,
      DEFAULT_SETTINGS.handoffUrgentPercent,
      2,
      100,
    ),
    executionTimeoutMs: coerceInteger(value.executionTimeoutMs, DEFAULT_SETTINGS.executionTimeoutMs, 15000, 600000),
    settleMs: coerceInteger(value.settleMs, DEFAULT_SETTINGS.settleMs, 500, 15000),
    retryLimit: coerceInteger(value.retryLimit, DEFAULT_SETTINGS.retryLimit, 0, 5),
    workbenchEnabled: value.workbenchEnabled === undefined ? DEFAULT_SETTINGS.workbenchEnabled : Boolean(value.workbenchEnabled),
  };
}

function clampCoordinate(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(0.96, Math.max(0.04, numeric));
}

export function createDefaultLayout(participants) {
  const layout = {};
  const total = Math.max(participants.length, 1);
  participants.forEach((participant, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total;
    layout[participant.id] = {
      x: clampCoordinate(0.5 + Math.cos(angle) * 0.38, 0.5),
      y: index === 0 ? 0.27 : clampCoordinate(0.5 + Math.sin(angle) * 0.34, 0.5),
    };
  });
  return layout;
}

export function normalizeLayout(participants, incomingLayout = {}, fallbackLayout = createDefaultLayout(participants)) {
  const layout = {};
  for (const participant of participants) {
    const fallback = fallbackLayout[participant.id] || { x: 0.5, y: 0.5 };
    const incoming = incomingLayout[participant.id] || fallback;
    layout[participant.id] = {
      x: clampCoordinate(incoming.x, fallback.x),
      y: clampCoordinate(incoming.y, fallback.y),
    };
  }
  return layout;
}

export function makeSessionId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function uniqueProviderIds(values) {
  return [...new Set(values)];
}
