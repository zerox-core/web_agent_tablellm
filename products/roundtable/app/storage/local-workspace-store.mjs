import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteFile, atomicWriteJson } from "@web-agents/local-core/atomic-file";

const STORE_SCHEMA = "web-agents-local-store.v1";
const SESSION_SCHEMA = "web-agents-roundtable-session.v1";
const EXPORT_SCHEMA = "web-agents-session-export.v1";

function safeSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== null && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function metadataFromSession(session) {
  return {
    schema: SESSION_SCHEMA,
    id: session.id,
    title: session.title,
    objective: session.objective || "",
    workspaceId: session.workspaceId || null,
    workspaceRoot: session.workspaceRoot || null,
    titleSource: session.titleSource || "explicit",
    renamedManually: Boolean(session.renamedManually),
    createdAt: session.createdAt,
  };
}

function stateFromSession(session) {
  return {
    updatedAt: session.updatedAt,
    participants: session.participants || [],
    hostId: session.hostId || null,
    layout: session.layout || {},
    settings: session.settings || {},
    plans: session.plans || [],
    summary: session.summary || null,
    runtime: session.runtime || {},
    artifacts: session.artifacts || [],
    threads: session.threads || {},
    context: session.context || { seatCursors: {}, summaries: [] },
    handoffs: session.handoffs || [],
    transactions: session.transactions || [],
    pendingParticipants: session.pendingParticipants || [],
    participantRoles: session.participantRoles || {},
    pendingInterventions: session.pendingInterventions || [],
    checkpoints: session.checkpoints || [],
    executionIndex: session.executionIndex || [],
    actionJournal: session.actionJournal || [],
    unreadCount: Number(session.unreadCount || 0),
  };
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`INVALID_JSONL:${filePath}:${index + 1}:${error.message}`);
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function resolveConfiguredDataRoot({ repoRoot, configFile, env = process.env } = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot || process.cwd());
  if (env.WEB_AGENTS_DATA_ROOT) return path.resolve(env.WEB_AGENTS_DATA_ROOT);
  const resolvedConfig = configFile || path.join(resolvedRepoRoot, "config", "data-root.local.txt");
  try {
    const configured = (await fs.readFile(resolvedConfig, "utf8")).replace(/^\uFEFF/, "").trim();
    if (configured) {
      if (!path.isAbsolute(configured)) throw new Error("DATA_ROOT_MUST_BE_ABSOLUTE");
      return path.resolve(configured);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return path.join(resolvedRepoRoot, "generated", "roundtable-data");
}

export class LocalWorkspaceStore {
  constructor({ repoRoot = process.cwd(), workspaceRoot = null, dataRoot = null, configFile = null, controlStore = null } = {}) {
    this.repoRoot = path.resolve(repoRoot);
    this.workspaceRoot = workspaceRoot ? path.resolve(workspaceRoot) : null;
    this.configFile = configFile || path.join(this.repoRoot, "config", "data-root.local.txt");
    this.dataRoot = dataRoot ? path.resolve(dataRoot) : null;
    this.rootSource = dataRoot ? "explicit" : "default";
    this.locks = new Map();
    this.controlStore = controlStore || null;
  }

  setControlStore(controlStore) {
    this.controlStore = controlStore || null;
    return this.controlStore;
  }

  async initialize() {
    if (!this.dataRoot) {
      this.dataRoot = await resolveConfiguredDataRoot({ repoRoot: this.repoRoot, configFile: this.configFile });
      this.rootSource = process.env.WEB_AGENTS_DATA_ROOT
        ? "environment"
        : (await pathExists(this.configFile)) ? "config" : "default";
    }
    await Promise.all([
      fs.mkdir(this.sessionsDir, { recursive: true }),
      fs.mkdir(this.auditDir, { recursive: true }),
      fs.mkdir(this.indexesDir, { recursive: true }),
      fs.mkdir(this.handoffsDir, { recursive: true }),
      fs.mkdir(this.artifactsDir, { recursive: true }),
      fs.mkdir(this.backupsDir, { recursive: true }),
      fs.mkdir(path.join(this.dataRoot, "exports"), { recursive: true }),
    ]);
    const storeFile = path.join(this.dataRoot, "store.json");
    if (!(await pathExists(storeFile))) {
      await atomicWriteJson(storeFile, {
        schema: STORE_SCHEMA,
        createdAt: new Date().toISOString(),
        dataRoot: this.dataRoot,
      });
    }
    if (!(await pathExists(this.indexFile))) await atomicWriteJson(this.indexFile, { schema: STORE_SCHEMA, sessions: [] });
    return this.describe();
  }

  get sessionsDir() {
    return path.join(this.dataRoot, "sessions");
  }

  get auditDir() {
    return path.join(this.dataRoot, "audit");
  }

  get indexesDir() {
    return path.join(this.dataRoot, "indexes");
  }

  get handoffsDir() {
    return path.join(this.dataRoot, "handoffs");
  }

  get artifactsDir() {
    return path.join(this.dataRoot, "artifacts");
  }

  get backupsDir() {
    return path.join(this.dataRoot, "backups");
  }

  get indexFile() {
    return path.join(this.indexesDir, "sessions.json");
  }

  describe() {
    return {
      schema: STORE_SCHEMA,
      dataRoot: this.dataRoot,
      workspaceRoot: this.workspaceRoot,
      workspaceId: this.workspaceRoot
        ? createHash("sha256").update(process.platform === "win32" ? this.workspaceRoot.toLowerCase() : this.workspaceRoot).digest("hex").slice(0, 20)
        : null,
      source: this.rootSource,
      configFile: this.configFile,
      sessionsDir: this.sessionsDir,
    };
  }

  getSessionPaths(sessionId) {
    const safeId = safeSegment(sessionId);
    if (!safeId || safeId !== sessionId) throw new Error("INVALID_SESSION_ID");
    const directory = path.join(this.sessionsDir, safeId);
    return {
      directory,
      metadata: path.join(directory, "session.json"),
      state: path.join(directory, "state.json"),
      ledger: path.join(directory, "ledger.jsonl"),
      summary: path.join(directory, "summary.md"),
      plans: path.join(directory, "plans"),
      replies: path.join(directory, "replies"),
      artifacts: path.join(directory, "artifacts"),
      diagnostics: path.join(directory, "diagnostics"),
      backups: path.join(directory, "backups"),
    };
  }

  async withLock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const ticket = new Promise((resolve) => { release = resolve; });
    const current = previous.then(() => ticket);
    this.locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async createSession(session) {
    await this.initialize();
    if (!session?.id || safeSegment(session.id) !== session.id) throw new Error("INVALID_SESSION_ID");
    const paths = this.getSessionPaths(session.id);
    if (await pathExists(paths.metadata)) throw new Error("SESSION_ALREADY_EXISTS");
    await Promise.all([
      fs.mkdir(paths.plans, { recursive: true }),
      fs.mkdir(paths.replies, { recursive: true }),
      fs.mkdir(paths.artifacts, { recursive: true }),
      fs.mkdir(paths.diagnostics, { recursive: true }),
      fs.mkdir(paths.backups, { recursive: true }),
    ]);
    await atomicWriteJson(paths.metadata, metadataFromSession(session));
    await atomicWriteJson(paths.state, stateFromSession(session));
    await fs.writeFile(paths.ledger, "", { encoding: "utf8", flag: "a" });
    if (session.events?.length) await this.appendEvents(session.id, session.events);
    await this.appendAudit({ kind: "session_create", sessionId: session.id, path: paths.directory });
    await this.reindex();
    return this.readSession(session.id);
  }

  async readSession(sessionId) {
    await this.initialize();
    const paths = this.getSessionPaths(sessionId);
    const [metadata, state, events] = await Promise.all([
      readJson(paths.metadata),
      readJson(paths.state),
      readJsonLines(paths.ledger),
    ]);
    return { ...metadata, ...state, schema: undefined, events };
  }

  async saveSessionUnlocked(session) {
    const paths = this.getSessionPaths(session.id);
    await atomicWriteJson(paths.metadata, metadataFromSession(session));
    await atomicWriteJson(paths.state, stateFromSession(session));
    if (this.controlStore?.available && Array.isArray(session.executionIndex) && session.executionIndex.length) {
      try {
        this.controlStore.importExecutions(session.executionIndex);
      } catch (error) {
        this.controlStore.markDegraded?.(error);
      }
    }
    for (const plan of session.plans || []) {
      if (plan?.id) await atomicWriteJson(path.join(paths.plans, `${safeSegment(plan.id)}.json`), plan);
    }
    await this.appendAudit({ kind: "session_state_write", sessionId: session.id, path: paths.state });
    await this.reindex();
    return this.readSession(session.id);
  }

  async saveSession(session) {
    await this.initialize();
    return this.withLock(session.id, () => this.saveSessionUnlocked(session));
  }

  async updateSession(sessionId, update) {
    await this.initialize();
    if (typeof update !== "function") throw new Error("SESSION_UPDATE_REQUIRED");
    return this.withLock(sessionId, async () => {
      const current = await this.readSession(sessionId);
      const updated = await update(current) || current;
      if (updated.id !== sessionId) throw new Error("SESSION_ID_MISMATCH");
      return this.saveSessionUnlocked(updated);
    });
  }

  async deleteSession(sessionId) {
    await this.initialize();
    return this.withLock(sessionId, async () => {
      const paths = this.getSessionPaths(sessionId);
      if (!(await pathExists(paths.metadata))) throw new Error("SESSION_NOT_FOUND");
      await fs.rm(paths.directory, { recursive: true, force: true });
      await this.appendAudit({ kind: "session_delete", sessionId, path: paths.directory });
      await this.reindex();
      return { id: sessionId };
    });
  }

  async appendEvents(sessionId, events) {
    await this.initialize();
    if (!Array.isArray(events) || events.length === 0) return this.readSession(sessionId);
    return this.withLock(sessionId, async () => {
      const paths = this.getSessionPaths(sessionId);
      const content = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      await fs.appendFile(paths.ledger, content, "utf8");
      const state = await readJson(paths.state);
      state.updatedAt = events.at(-1)?.createdAt || new Date().toISOString();
      await atomicWriteJson(paths.state, state);
      await this.appendAudit({ kind: "ledger_append", sessionId, path: paths.ledger, count: events.length });
      return this.readSession(sessionId);
    });
  }

  async writeReply(sessionId, { planId, turnId, providerId, round, content }) {
    const paths = this.getSessionPaths(sessionId);
    const roundPart = String(round || 1).padStart(2, "0");
    const filePath = path.join(paths.replies, `${safeSegment(planId)}-r${roundPart}-${safeSegment(providerId)}-${safeSegment(turnId)}.md`);
    await atomicWriteFile(filePath, `${content.trim()}\n`);
    await this.appendAudit({ kind: "reply_write", sessionId, planId, turnId, providerId, path: filePath });
    return filePath;
  }

  async writeSummaryFile(sessionId, content) {
    const paths = this.getSessionPaths(sessionId);
    await atomicWriteFile(paths.summary, content);
    await this.appendAudit({ kind: "summary_write", sessionId, path: paths.summary });
    return paths.summary;
  }

  async appendAudit(event) {
    await fs.mkdir(this.auditDir, { recursive: true });
    await fs.appendFile(
      path.join(this.auditDir, "events.jsonl"),
      `${JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...event })}\n`,
      "utf8"
    );
  }

  async listAudit({ sessionId = null, limit = 200 } = {}) {
    const events = await readJsonLines(path.join(this.auditDir, "events.jsonl"));
    return events.filter((event) => !sessionId || event.sessionId === sessionId).slice(-limit);
  }

  async reindex() {
    await this.initializeDirectoriesOnly();
    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const paths = this.getSessionPaths(entry.name);
        const [metadata, state] = await Promise.all([readJson(paths.metadata), readJson(paths.state)]);
        sessions.push({
          id: metadata.id,
          title: metadata.title,
          objective: metadata.objective || "",
          createdAt: metadata.createdAt,
          updatedAt: state.updatedAt || metadata.createdAt,
          participants: (state.participants || []).map((participant) => participant.id),
          mode: state.settings?.conversationMode || "discussion",
          status: state.runtime?.status || "idle",
        });
      } catch {
        // Invalid directories are ignored and remain available for manual repair.
      }
    }
    sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    await atomicWriteJson(this.indexFile, { schema: STORE_SCHEMA, updatedAt: new Date().toISOString(), sessions });
    return { sessions };
  }

  async initializeDirectoriesOnly() {
    await Promise.all([
      fs.mkdir(this.sessionsDir, { recursive: true }),
      fs.mkdir(this.auditDir, { recursive: true }),
      fs.mkdir(this.indexesDir, { recursive: true }),
      fs.mkdir(this.handoffsDir, { recursive: true }),
      fs.mkdir(this.artifactsDir, { recursive: true }),
      fs.mkdir(this.backupsDir, { recursive: true }),
    ]);
  }

  async listSessions() {
    await this.initialize();
    const index = await readJson(this.indexFile, { sessions: [] });
    return index.sessions || [];
  }

  async exportSession(sessionId, destination = null) {
    const session = await this.readSession(sessionId);
    const target = destination ? path.resolve(destination) : path.join(this.dataRoot, "exports");
    const filePath = path.extname(target).toLowerCase() === ".json"
      ? target
      : path.join(target, `${sessionId}-${new Date().toISOString().replace(/[:.]/g, "")}.json`);
    await atomicWriteJson(filePath, { schema: EXPORT_SCHEMA, exportedAt: new Date().toISOString(), session });
    await this.appendAudit({ kind: "session_export", sessionId, path: filePath });
    return { filePath };
  }

  async importFromPath(sourcePath) {
    await this.initialize();
    const resolved = path.resolve(sourcePath);
    const stat = await fs.stat(resolved);
    const candidates = [];
    if (stat.isFile()) {
      candidates.push(await this.readImportFile(resolved));
    } else if (await pathExists(path.join(resolved, "ledger.json"))) {
      candidates.push(await readJson(path.join(resolved, "ledger.json")));
    } else if (await pathExists(path.join(resolved, "session.json"))) {
      candidates.push(await this.readPortableSessionDirectory(resolved));
    } else {
      const sessionsRoot = await pathExists(path.join(resolved, "sessions")) ? path.join(resolved, "sessions") : resolved;
      const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(sessionsRoot, entry.name);
        if (await pathExists(path.join(directory, "ledger.json"))) {
          candidates.push(await readJson(path.join(directory, "ledger.json")));
        } else if (await pathExists(path.join(directory, "session.json"))) {
          candidates.push(await this.readPortableSessionDirectory(directory));
        }
      }
    }

    const imported = [];
    const skipped = [];
    for (const candidate of candidates.filter(Boolean)) {
      try {
        await this.importSessionObject(candidate);
        imported.push(candidate.id);
      } catch (error) {
        skipped.push({ id: candidate?.id || null, error: error.message });
      }
    }
    await this.reindex();
    await this.appendAudit({ kind: "session_import", path: resolved, imported, skipped });
    return { imported, skipped };
  }

  async readImportFile(filePath) {
    const value = await readJson(filePath);
    return value.schema === EXPORT_SCHEMA ? value.session : value;
  }

  async readPortableSessionDirectory(directory) {
    const [metadata, state, events] = await Promise.all([
      readJson(path.join(directory, "session.json")),
      readJson(path.join(directory, "state.json")),
      readJsonLines(path.join(directory, "ledger.jsonl")),
    ]);
    return { ...metadata, ...state, schema: undefined, events };
  }

  async importSessionObject(candidate) {
    if (!candidate?.id || safeSegment(candidate.id) !== candidate.id) throw new Error("INVALID_IMPORTED_SESSION");
    if (await pathExists(this.getSessionPaths(candidate.id).metadata)) throw new Error("SESSION_ALREADY_EXISTS");
    const now = new Date().toISOString();
    return this.createSession({
      ...candidate,
      title: String(candidate.title || "Imported roundtable"),
      objective: String(candidate.objective || ""),
      workspaceId: candidate.workspaceId || null,
      workspaceRoot: candidate.workspaceRoot || this.workspaceRoot,
      titleSource: candidate.titleSource || "imported",
      renamedManually: Boolean(candidate.renamedManually),
      createdAt: candidate.createdAt || now,
      updatedAt: candidate.updatedAt || candidate.createdAt || now,
      participants: candidate.participants || [],
      hostId: candidate.hostId || null,
      layout: candidate.layout || {},
      settings: candidate.settings || {},
      plans: candidate.plans || [],
      summary: candidate.summary || null,
      runtime: candidate.runtime || {},
      artifacts: candidate.artifacts || [],
      threads: candidate.threads || {},
      context: candidate.context || { seatCursors: {}, summaries: [] },
      handoffs: candidate.handoffs || [],
      transactions: candidate.transactions || [],
      pendingParticipants: candidate.pendingParticipants || [],
      participantRoles: candidate.participantRoles || {},
      pendingInterventions: candidate.pendingInterventions || [],
      checkpoints: candidate.checkpoints || [],
      actionJournal: candidate.actionJournal || [],
      unreadCount: Number(candidate.unreadCount || 0),
      events: candidate.events || [],
    });
  }

  async setDataRoot(nextRoot) {
    if (!path.isAbsolute(String(nextRoot || ""))) throw new Error("DATA_ROOT_MUST_BE_ABSOLUTE");
    const resolved = path.resolve(nextRoot);
    await fs.mkdir(resolved, { recursive: true });
    await atomicWriteFile(this.configFile, `${resolved}\n`);
    this.dataRoot = resolved;
    this.rootSource = "config";
    await this.initialize();
    return this.describe();
  }
}

export { atomicWriteFile, atomicWriteJson, readJsonLines, safeSegment };
