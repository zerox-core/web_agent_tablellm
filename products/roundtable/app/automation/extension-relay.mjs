import { randomUUID } from "node:crypto";

import { AutomationError } from "./errors.mjs";

export const EXTENSION_RELAY_REQUEST_TYPES = new Set([
  "tabs:open-provider",
  "tabs:discover-providers",
  "tabs:probe-provider",
  "tabs:focus-provider",
  "tab:auth-probe",
  "tab:detect",
  "tab:insert-text",
  "tab:auto-send-text",
  "tab:capture-latest",
  "tab:capture-recent",
]);
export const LEGACY_EXTENSION_VERSION = "0.1.0";
export const LEGACY_BRIDGE_REVISION = "legacy-sidecar-v1";
const EXTENSION_PROVIDER_IDS = new Set(["chatgpt", "deepseek", "doubao", "kimi", "glm", "gemini"]);
const EXTENSION_RESULT_PROVIDER_IDS = new Set([...EXTENSION_PROVIDER_IDS, "unknown"]);
const AUTH_REASONS = new Set([
  "authenticated",
  "login_required",
  "token_missing",
  "probe_failed",
  "unsupported_provider",
  "human_verification_required",
  "adapter_not_ready",
  "adapter_activation_failed",
  "adapter_activation_timeout",
  "composer_not_found",
  "content_bridge_missing",
  "content_bridge_timeout",
  "probe_timeout",
  "provider_url_mismatch",
]);
const READINESS_STATES = new Set(["supported", "unsupported", "no_input", "unknown"]);
const ADAPTER_BRIDGE_STATES = new Set(["ready", "missing", "timed_out"]);
const ADAPTER_SOURCES = new Set(["plugin_registry", "current_adapter", "mcp_adapter", "none"]);
const ADAPTER_ACTIVATION_STATES = new Set([
  "not_needed",
  "unsupported",
  "succeeded",
  "ineffective",
  "failed",
  "timed_out",
]);
const AUTO_SEND_STATES = new Set(["sent", "no_input", "input_busy", "no_submit", "verification_required"]);
const INSERT_STATES = new Set(["inserted", "no_input", "input_busy"]);
const SPEAKER_STATES = new Set(["user", "assistant", "unknown"]);
const MAX_RELAY_TEXT_LENGTH = 1_000_000;
const MAX_RELAY_RESULT_LENGTH = 5_000_000;

function relayError(code, message, details = {}) {
  return new AutomationError(code, message, details);
}

function validateClientId(value) {
  const clientId = String(value || "").trim();
  if (!/^[a-zA-Z0-9._-]{8,128}$/.test(clientId)) {
    throw relayError("INVALID_EXTENSION_CLIENT", "Extension relay client id is invalid.");
  }
  return clientId;
}

function normalizeExtensionVersion(value) {
  return value ? String(value).slice(0, 40) : null;
}

function normalizeBridgeRevision(value) {
  return value ? String(value).slice(0, 80) : null;
}

function isCompatibleBridge(extensionVersion, bridgeRevision) {
  return extensionVersion === LEGACY_EXTENSION_VERSION && bridgeRevision === LEGACY_BRIDGE_REVISION;
}

function assertCompatibleAvailability(available, extensionVersion, bridgeRevision) {
  if (!available || isCompatibleBridge(extensionVersion, bridgeRevision)) return;
  throw relayError(
    "EXTENSION_BRIDGE_INCOMPATIBLE",
    "The roundtable page is not connected through the required legacy extension bridge.",
    {
      expectedExtensionVersion: LEGACY_EXTENSION_VERSION,
      expectedBridgeRevision: LEGACY_BRIDGE_REVISION,
    },
  );
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || !EXTENSION_RELAY_REQUEST_TYPES.has(request.type)) {
    throw relayError("EXTENSION_REQUEST_NOT_ALLOWED", "The extension relay request type is not allowed.", {
      type: request?.type || null,
    });
  }
  const provider = () => {
    const value = String(request.provider || "");
    if (!EXTENSION_PROVIDER_IDS.has(value)) {
      throw relayError("INVALID_EXTENSION_REQUEST", "The extension relay provider is invalid.", { type: request.type });
    }
    return value;
  };
  const tabId = () => {
    const value = Number(request.tabId);
    if (!Number.isInteger(value) || value < 0) {
      throw relayError("INVALID_EXTENSION_REQUEST", "The extension relay tab id is invalid.", { type: request.type });
    }
    return value;
  };

  switch (request.type) {
    case "tabs:open-provider":
      return { type: request.type, provider: provider() };
    case "tabs:discover-providers": {
      if (request.providers === undefined) return { type: request.type };
      if (!Array.isArray(request.providers) || request.providers.length > EXTENSION_PROVIDER_IDS.size) {
        throw relayError("INVALID_EXTENSION_REQUEST", "The extension relay provider list is invalid.", { type: request.type });
      }
      return { type: request.type, providers: request.providers.map((value) => {
        if (!EXTENSION_PROVIDER_IDS.has(String(value))) {
          throw relayError("INVALID_EXTENSION_REQUEST", "The extension relay provider list is invalid.", { type: request.type });
        }
        return String(value);
      }) };
    }
    case "tabs:probe-provider":
      return {
        type: request.type,
        provider: provider(),
        ...(request.tabId === undefined ? {} : { tabId: tabId() }),
      };
    case "tabs:focus-provider":
    case "tab:auth-probe":
    case "tab:detect":
    case "tab:capture-latest":
      return { type: request.type, tabId: tabId() };
    case "tab:capture-recent": {
      const limit = request.limit === undefined ? undefined : Number(request.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 80)) {
        throw relayError("INVALID_EXTENSION_REQUEST", "The extension relay capture limit is invalid.", { type: request.type });
      }
      return { type: request.type, tabId: tabId(), ...(limit === undefined ? {} : { limit }) };
    }
    case "tab:insert-text":
    case "tab:auto-send-text": {
      if (typeof request.text !== "string" || !request.text.trim() || request.text.length > MAX_RELAY_TEXT_LENGTH) {
        throw relayError("INVALID_EXTENSION_REQUEST", "The extension relay text payload is invalid.", { type: request.type });
      }
      return { type: request.type, tabId: tabId(), text: request.text };
    }
    default:
      throw relayError("EXTENSION_REQUEST_NOT_ALLOWED", "The extension relay request type is not allowed.");
  }
}

function resultObject(value, type) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw relayError("INVALID_EXTENSION_RESULT", `The ${type} extension result data is invalid.`);
  }
  return value;
}

function resultString(value, field, { max = 10000, optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw relayError("INVALID_EXTENSION_RESULT", `The extension result ${field} is invalid.`);
  }
  return value;
}

function resultBoolean(value, field, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw relayError("INVALID_EXTENSION_RESULT", `The extension result ${field} is invalid.`);
  }
  return value;
}

function resultInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw relayError("INVALID_EXTENSION_RESULT", `The extension result ${field} is invalid.`);
  }
  return value;
}

function resultEnum(value, field, allowed) {
  if (!allowed.has(value)) {
    throw relayError("INVALID_EXTENSION_RESULT", `The extension result ${field} is invalid.`);
  }
  return value;
}

function resultProvider(value, { allowUnknown = false } = {}) {
  const allowed = allowUnknown ? EXTENSION_RESULT_PROVIDER_IDS : EXTENSION_PROVIDER_IDS;
  return resultEnum(value, "provider", allowed);
}

function resultAssistantSpeaker(value) {
  const speaker = resultEnum(value, "speaker", SPEAKER_STATES);
  if (speaker !== "assistant") {
    throw relayError("INVALID_EXTENSION_RESULT", "The extension result speaker is not assistant.");
  }
  return speaker;
}

function resultUrl(value) {
  const raw = resultString(value, "url", { max: 4096 });
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("unsafe");
    return `${url.origin}${url.pathname}`;
  } catch {
    throw relayError("INVALID_EXTENSION_RESULT", "The extension result URL is not sanitized.");
  }
}

function normalizeAdapterDiagnostics(value) {
  const data = resultObject(value, "adapter-diagnostics");
  const normalized = {
    bridgeState: resultEnum(data.bridgeState, "bridgeState", ADAPTER_BRIDGE_STATES),
    adapterSource: resultEnum(data.adapterSource, "adapterSource", ADAPTER_SOURCES),
    activationState: resultEnum(data.activationState, "activationState", ADAPTER_ACTIVATION_STATES),
    sidecarInjected: resultBoolean(data.sidecarInjected, "sidecarInjected"),
  };
  for (const field of [
    "composerFound",
    "adapterPresent",
    "hasInsertText",
    "hasInsertTextIntoInput",
    "hasSubmitForm",
  ]) {
    if (data[field] !== undefined) normalized[field] = resultBoolean(data[field], field);
  }
  return normalized;
}

function redactResultError(value) {
  const text = resultString(value, "error", { max: 10000 });
  return text.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    const trailing = match.match(/[),.;!?]+$/)?.[0] || "";
    const candidate = trailing ? match.slice(0, -trailing.length) : match;
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}${trailing}`;
    } catch {
      return match;
    }
  });
}

function normalizeOpenProviderResult(dataValue) {
  const data = resultObject(dataValue, "open-provider");
  return {
    provider: resultProvider(data.provider),
    label: resultString(data.label, "label", { max: 100 }),
    tabId: resultInteger(data.tabId, "tabId"),
    url: resultUrl(data.url),
    status: resultString(data.status, "status", { max: 40 }),
    reused: resultBoolean(data.reused, "reused", { optional: true }) ?? false,
  };
}

function normalizeProviderStatus(dataValue) {
  const data = resultObject(dataValue, "provider-status");
  const normalized = {
    provider: resultProvider(data.provider),
    authenticated: resultBoolean(data.authenticated, "authenticated"),
    reason: resultEnum(data.reason, "reason", AUTH_REASONS),
    tabId: resultInteger(data.tabId, "tabId"),
    label: resultString(data.label, "label", { max: 100 }),
    url: resultUrl(data.url),
    readiness: resultEnum(data.readiness, "readiness", READINESS_STATES),
    canInsert: resultBoolean(data.canInsert, "canInsert"),
    ready: resultBoolean(data.ready, "ready"),
    verificationRequired: resultBoolean(data.verificationRequired, "verificationRequired"),
  };
  if (data.matchedSelector !== undefined) {
    normalized.matchedSelector = resultString(data.matchedSelector, "matchedSelector", { max: 500 });
  }
  if (data.adapterDiagnostics !== undefined) {
    normalized.adapterDiagnostics = normalizeAdapterDiagnostics(data.adapterDiagnostics);
  }
  if (data.error !== undefined) normalized.error = redactResultError(data.error);
  return normalized;
}

function normalizeResultData(type, dataValue) {
  const data = resultObject(dataValue, type);
  switch (type) {
    case "tabs:open-provider":
    case "tabs:focus-provider":
      return normalizeOpenProviderResult(data);
    case "tabs:discover-providers": {
      if (!Array.isArray(data.tabs) || data.tabs.length > 100) {
        throw relayError("INVALID_EXTENSION_RESULT", "The extension result provider tabs are invalid.");
      }
      return { tabs: data.tabs.map((tab) => normalizeProviderStatus(tab)) };
    }
    case "tabs:probe-provider":
      return normalizeProviderStatus(data);
    case "tab:auth-probe": {
      const normalized = {
        provider: resultProvider(data.provider, { allowUnknown: true }),
        authenticated: resultBoolean(data.authenticated, "authenticated"),
        reason: resultEnum(data.reason, "reason", AUTH_REASONS),
      };
      if (data.verificationRequired !== undefined) {
        normalized.verificationRequired = resultBoolean(data.verificationRequired, "verificationRequired");
      }
      if (data.adapterDiagnostics !== undefined) {
        normalized.adapterDiagnostics = normalizeAdapterDiagnostics(data.adapterDiagnostics);
      }
      return normalized;
    }
    case "tab:detect": {
      const normalized = {
        provider: resultProvider(data.provider, { allowUnknown: true }),
        label: resultString(data.label, "label", { max: 100 }),
        readiness: resultEnum(data.readiness, "readiness", READINESS_STATES),
        canInsert: resultBoolean(data.canInsert, "canInsert"),
        tabId: resultInteger(data.tabId, "tabId"),
      };
      if (data.url !== undefined) normalized.url = resultUrl(data.url);
      if (data.reason !== undefined) normalized.reason = resultString(data.reason, "reason", { max: 500 });
      if (data.matchedSelector !== undefined) {
        normalized.matchedSelector = resultString(data.matchedSelector, "matchedSelector", { max: 500 });
      }
      if (data.verificationRequired !== undefined) {
        normalized.verificationRequired = resultBoolean(data.verificationRequired, "verificationRequired");
      }
      return normalized;
    }
    case "tab:insert-text":
      return {
        ok: resultBoolean(data.ok, "ok"),
        provider: resultProvider(data.provider, { allowUnknown: true }),
        ...(data.state === undefined ? {} : { state: resultEnum(data.state, "state", INSERT_STATES) }),
        message: resultString(data.message, "message", { max: 1000 }),
      };
    case "tab:auto-send-text":
      return {
        provider: resultProvider(data.provider, { allowUnknown: true }),
        state: resultEnum(data.state, "state", AUTO_SEND_STATES),
        message: resultString(data.message, "message", { max: 1000 }),
      };
    case "tab:capture-latest": {
      const normalized = {
        provider: resultProvider(data.provider, { allowUnknown: true }),
        speaker: resultAssistantSpeaker(data.speaker),
        text: resultString(data.text, "text", { max: MAX_RELAY_TEXT_LENGTH }),
        capturedAt: resultString(data.capturedAt, "capturedAt", { max: 100 }),
      };
      if (data.source !== undefined) normalized.source = resultString(data.source, "source", { max: 200 });
      return normalized;
    }
    case "tab:capture-recent": {
      if (!Array.isArray(data.messages) || data.messages.length > 80) {
        throw relayError("INVALID_EXTENSION_RESULT", "The extension result messages are invalid.");
      }
      return {
        provider: resultProvider(data.provider, { allowUnknown: true }),
        capturedAt: resultString(data.capturedAt, "capturedAt", { max: 100 }),
        messages: data.messages.map((messageValue) => {
          const message = resultObject(messageValue, "conversation-message");
          return {
            speaker: resultAssistantSpeaker(message.speaker),
            text: resultString(message.text, "text", { max: MAX_RELAY_TEXT_LENGTH }),
            source: resultString(message.source, "source", { max: 200 }),
          };
        }),
      };
    }
    default:
      throw relayError("INVALID_EXTENSION_RESULT", "The extension result type is unsupported.", { type });
  }
}

function normalizeResult(type, result) {
  if (!result.ok) {
    return { ok: false, type, error: redactResultError(result.error) };
  }
  return { ok: true, type, data: normalizeResultData(type, result.data) };
}

export class ExtensionRelay {
  constructor({
    clientTtlMs = 15000,
    commandTimeoutMs = 30000,
    now = () => Date.now(),
  } = {}) {
    this.clientTtlMs = clientTtlMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.now = now;
    this.clients = new Map();
    this.pending = new Map();
    this.activeClientId = null;
    this.closed = false;
  }

  register(clientIdValue, { available = false, extensionVersion = null, bridgeRevision = null } = {}) {
    if (this.closed) throw relayError("EXTENSION_BRIDGE_CLOSED", "The extension relay is closed.");
    const clientId = validateClientId(clientIdValue);
    const existing = this.clients.get(clientId);
    const normalizedExtensionVersion = normalizeExtensionVersion(extensionVersion);
    const normalizedBridgeRevision = normalizeBridgeRevision(bridgeRevision);
    const requestedAvailability = Boolean(available);
    try {
      assertCompatibleAvailability(requestedAvailability, normalizedExtensionVersion, normalizedBridgeRevision);
    } catch (error) {
      if (existing) {
        existing.extensionVersion = normalizedExtensionVersion;
        existing.bridgeRevision = normalizedBridgeRevision;
        existing.verified = false;
        existing.lastSeenAt = this.now();
        this.deactivateClient(existing, "The extension relay client became incompatible.");
      }
      throw error;
    }
    const verified = isCompatibleBridge(normalizedExtensionVersion, normalizedBridgeRevision);
    if (existing && !requestedAvailability) {
      this.deactivateClient(existing, "The extension relay client became unavailable.");
    }
    const client = {
      clientId,
      available: requestedAvailability && verified,
      verified,
      extensionVersion: normalizedExtensionVersion,
      bridgeRevision: normalizedBridgeRevision,
      connectedAt: existing?.connectedAt || this.now(),
      lastSeenAt: this.now(),
      queue: existing?.queue || [],
    };
    this.clients.set(clientId, client);
    this.cleanupStaleClients();
    return this.clientStatus(client);
  }

  heartbeat(clientIdValue, patch = {}) {
    const client = this.requireClient(clientIdValue);
    const extensionVersion = patch.extensionVersion === undefined
      ? client.extensionVersion
      : normalizeExtensionVersion(patch.extensionVersion);
    const bridgeRevision = patch.bridgeRevision === undefined
      ? client.bridgeRevision
      : normalizeBridgeRevision(patch.bridgeRevision);
    const available = patch.available === undefined ? client.available : Boolean(patch.available);
    try {
      assertCompatibleAvailability(available, extensionVersion, bridgeRevision);
    } catch (error) {
      client.extensionVersion = extensionVersion;
      client.bridgeRevision = bridgeRevision;
      client.verified = false;
      client.lastSeenAt = this.now();
      this.deactivateClient(client, "The extension relay client became incompatible.");
      throw error;
    }
    client.extensionVersion = extensionVersion;
    client.bridgeRevision = bridgeRevision;
    client.verified = isCompatibleBridge(extensionVersion, bridgeRevision);
    client.available = available && client.verified;
    client.lastSeenAt = this.now();
    if (!client.available) {
      this.deactivateClient(client, "The extension relay client became unavailable.");
    }
    return this.clientStatus(client);
  }

  poll(clientIdValue) {
    const client = this.requireClient(clientIdValue);
    client.lastSeenAt = this.now();
    if (!client.available || !client.verified) return null;
    const command = client.queue.shift() || null;
    if (command) {
      command.deliveredAt = this.now();
      const pending = this.pending.get(command.commandId);
      if (pending) pending.deliveredAt = command.deliveredAt;
    }
    return command ? structuredClone(command) : null;
  }

  complete(clientIdValue, commandIdValue, result) {
    const client = this.requireClient(clientIdValue);
    client.lastSeenAt = this.now();
    const commandId = String(commandIdValue || "").trim();
    const pending = this.pending.get(commandId);
    if (!pending || pending.clientId !== client.clientId) {
      throw relayError("EXTENSION_COMMAND_NOT_FOUND", "The extension relay command is no longer active.", { commandId });
    }
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
      throw relayError("INVALID_EXTENSION_RESULT", "The extension relay result is invalid.", { commandId });
    }
    if (result.type !== pending.requestType) {
      throw relayError("INVALID_EXTENSION_RESULT", "The extension relay result type does not match its command.", {
        commandId,
        expectedType: pending.requestType,
        receivedType: result.type || null,
      });
    }
    let resultLength;
    try {
      resultLength = JSON.stringify(result).length;
    } catch {
      throw relayError("INVALID_EXTENSION_RESULT", "The extension relay result is not serializable.", { commandId });
    }
    if (resultLength > MAX_RELAY_RESULT_LENGTH) {
      throw relayError("INVALID_EXTENSION_RESULT", "The extension relay result is too large.", { commandId });
    }
    const normalizedResult = normalizeResult(pending.requestType, result);
    clearTimeout(pending.timer);
    this.pending.delete(commandId);
    pending.resolve(structuredClone(normalizedResult));
    return { commandId, completed: true };
  }

  dispatch(requestValue, { timeoutMs = this.commandTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(relayError("EXTENSION_BRIDGE_CLOSED", "The extension relay is closed."));
    let request;
    try {
      request = validateRequest(requestValue);
      this.cleanupStaleClients();
    } catch (error) {
      return Promise.reject(error);
    }
    const client = this.selectDispatchClient();
    if (!client) {
      return Promise.reject(relayError(
        "EXTENSION_BRIDGE_UNAVAILABLE",
        "No active roundtable page is connected to the Web Agents extension."
      ));
    }

    const commandId = randomUUID();
    const createdAt = this.now();
    const effectiveTimeout = Math.max(250, Number(timeoutMs) || this.commandTimeoutMs);
    const command = {
      commandId,
      request,
      createdAt,
      expiresAt: createdAt + effectiveTimeout,
    };
    client.queue.push(command);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        const index = client.queue.findIndex((candidate) => candidate.commandId === commandId);
        if (index >= 0) client.queue.splice(index, 1);
        reject(relayError("EXTENSION_COMMAND_TIMEOUT", "The Web Agents extension command timed out.", {
          commandId,
          type: request.type,
        }));
      }, effectiveTimeout);
      timer.unref?.();
      this.pending.set(commandId, {
        clientId: client.clientId,
        requestType: request.type,
        createdAt,
        deliveredAt: null,
        timer,
        resolve,
        reject,
      });
    });
  }

  status() {
    this.cleanupStaleClients();
    const clients = [...this.clients.values()].map((client) => this.clientStatus(client));
    return {
      connected: clients.some((client) => client.available),
      clients,
      pendingCommands: this.pending.size,
    };
  }

  clientStatus(client) {
    return {
      clientId: client.clientId,
      available: client.available,
      verified: client.verified,
      extensionVersion: client.extensionVersion,
      bridgeRevision: client.bridgeRevision,
      connectedAt: new Date(client.connectedAt).toISOString(),
      lastSeenAt: new Date(client.lastSeenAt).toISOString(),
      queuedCommands: client.queue.length,
    };
  }

  requireClient(clientIdValue) {
    if (this.closed) throw relayError("EXTENSION_BRIDGE_CLOSED", "The extension relay is closed.");
    const clientId = validateClientId(clientIdValue);
    const client = this.clients.get(clientId);
    if (!client) throw relayError("EXTENSION_CLIENT_NOT_FOUND", "The extension relay client is not registered.");
    return client;
  }

  isClientFresh(client) {
    return this.now() - client.lastSeenAt <= this.clientTtlMs;
  }

  isDispatchEligible(client) {
    return Boolean(client?.available && client.verified && this.isClientFresh(client));
  }

  selectDispatchClient() {
    const active = this.activeClientId ? this.clients.get(this.activeClientId) : null;
    if (this.isDispatchEligible(active)) return active;
    this.activeClientId = null;
    const client = [...this.clients.values()]
      .filter((candidate) => this.isDispatchEligible(candidate))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0] || null;
    if (client) this.activeClientId = client.clientId;
    return client;
  }

  deactivateClient(client, message) {
    client.available = false;
    client.queue.length = 0;
    if (this.activeClientId === client.clientId) this.activeClientId = null;
    for (const [commandId, pending] of this.pending.entries()) {
      if (pending.clientId !== client.clientId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(commandId);
      pending.reject(relayError("EXTENSION_BRIDGE_UNAVAILABLE", message, { commandId }));
    }
  }

  cleanupStaleClients() {
    for (const [clientId, client] of this.clients.entries()) {
      if (this.isClientFresh(client)) continue;
      this.clients.delete(clientId);
      if (this.activeClientId === clientId) this.activeClientId = null;
      for (const [commandId, pending] of this.pending.entries()) {
        if (pending.clientId !== clientId) continue;
        clearTimeout(pending.timer);
        this.pending.delete(commandId);
        pending.reject(relayError("EXTENSION_BRIDGE_UNAVAILABLE", "The extension relay client disconnected.", {
          commandId,
        }));
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [commandId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(relayError("EXTENSION_BRIDGE_CLOSED", "The extension relay closed before the command completed.", {
        commandId,
      }));
    }
    this.pending.clear();
    this.clients.clear();
    this.activeClientId = null;
  }
}

export { validateClientId, validateRequest };
