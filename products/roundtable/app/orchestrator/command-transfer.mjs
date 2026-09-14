import { createHash, randomUUID } from "node:crypto";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL = 64;

export class CommandTransferError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "CommandTransferError";
    this.code = code;
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(String(text), "utf8")).digest("hex");
}

function byteLength(text) {
  return Buffer.byteLength(String(text), "utf8");
}

/**
 * In-memory, session-scoped registry for chunked command uploads.
 * Mirrors the local-core manage_text_transfer protocol: begin -> ordered
 * append chunks -> commit verifies declared size + sha256, then hands the
 * assembled text back for dispatch. Transfers expire lazily after a TTL so
 * abandoned uploads never pin memory.
 */
export class CommandTransferRegistry {
  constructor({ maxBytes = DEFAULT_MAX_BYTES, chunkBytes = DEFAULT_CHUNK_BYTES, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.chunkBytes = Math.max(1024, Number(chunkBytes) || DEFAULT_CHUNK_BYTES);
    this.ttlMs = Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS);
    this.now = now;
    this.transfers = new Map();
    this.operations = 0;
    this.lastSweptAt = Number(this.now());
  }

  sweep() {
    const timestamp = Number(this.now());
    this.lastSweptAt = timestamp;
    for (const [sessionId, transfers] of this.transfers) {
      for (const [transferId, transfer] of transfers) {
        if (timestamp - transfer.updatedAt > this.ttlMs) transfers.delete(transferId);
      }
      if (!transfers.size) this.transfers.delete(sessionId);
    }
  }

  maybeSweep() {
    if (this.operations % SWEEP_INTERVAL === 0 || Number(this.now()) - this.lastSweptAt > this.ttlMs) this.sweep();
  }

  require(sessionId, transferId) {
    const transfers = this.transfers.get(String(sessionId || ""));
    const transfer = transfers ? transfers.get(String(transferId || "")) : null;
    if (!transfer) throw new CommandTransferError("COMMAND_TRANSFER_NOT_FOUND", "Unknown or expired command transfer.");
    return transfer;
  }

  begin(sessionId, options = {}) {
    this.operations += 1;
    this.maybeSweep();
    const expectedBytes = options.expectedBytes;
    if (!Number.isInteger(expectedBytes) || expectedBytes <= 0) {
      throw new CommandTransferError("INVALID_COMMAND_TRANSFER", "expectedBytes must be a positive integer.");
    }
    if (expectedBytes > this.maxBytes) {
      throw new CommandTransferError("COMMAND_TRANSFER_TOO_LARGE", `expectedBytes ${expectedBytes} exceeds the ${this.maxBytes} byte limit.`);
    }
    const expectedSha256 = String(options.expectedSha256 || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new CommandTransferError("INVALID_COMMAND_TRANSFER", "expectedSha256 must be a 64 character hex sha256 digest.");
    }
    const command = options.command && typeof options.command === "object" ? options.command : {};
    if (typeof command.text === "string" && command.text.length) {
      throw new CommandTransferError("INVALID_COMMAND_TRANSFER", "command.text must be empty; text arrives via chunks.");
    }
    const transferId = randomUUID();
    const timestamp = Number(this.now());
    const transfer = {
      id: transferId,
      sessionId: String(sessionId || ""),
      expectedBytes,
      expectedSha256,
      command,
      chunks: [],
      receivedBytes: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!this.transfers.has(transfer.sessionId)) this.transfers.set(transfer.sessionId, new Map());
    this.transfers.get(transfer.sessionId).set(transferId, transfer);
    return { transferId, chunkBytes: this.chunkBytes, expectedBytes, receivedChunks: 0, receivedBytes: 0 };
  }

  append(sessionId, transferId, options = {}) {
    this.operations += 1;
    this.maybeSweep();
    const transfer = this.require(sessionId, transferId);
    const chunkIndex = options.chunkIndex;
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new CommandTransferError("INVALID_COMMAND_TRANSFER", "chunkIndex must be a non-negative integer.");
    }
    const content = String(options.content ?? "");
    if (chunkIndex !== transfer.chunks.length) {
      throw new CommandTransferError("COMMAND_TRANSFER_CHUNK_OUT_OF_ORDER", `Expected chunkIndex ${transfer.chunks.length} but received ${chunkIndex}.`);
    }
    const chunkBytes = byteLength(content);
    if (chunkBytes > this.chunkBytes) {
      throw new CommandTransferError("COMMAND_TRANSFER_TOO_LARGE", `Chunk of ${chunkBytes} bytes exceeds the ${this.chunkBytes} byte limit.`);
    }
    if (transfer.receivedBytes + chunkBytes > transfer.expectedBytes) {
      throw new CommandTransferError("COMMAND_TRANSFER_SIZE_EXCEEDED", `Uploaded ${transfer.receivedBytes + chunkBytes} bytes exceeds the declared ${transfer.expectedBytes} bytes.`);
    }
    transfer.chunks.push(content);
    transfer.receivedBytes += chunkBytes;
    transfer.updatedAt = Number(this.now());
    return {
      transferId: transfer.id,
      receivedChunks: transfer.chunks.length,
      receivedBytes: transfer.receivedBytes,
      expectedBytes: transfer.expectedBytes,
      complete: transfer.receivedBytes === transfer.expectedBytes,
    };
  }

  status(sessionId, transferId) {
    this.operations += 1;
    this.maybeSweep();
    const transfer = this.require(sessionId, transferId);
    return {
      transferId: transfer.id,
      expectedBytes: transfer.expectedBytes,
      receivedBytes: transfer.receivedBytes,
      receivedChunks: transfer.chunks.length,
      chunkBytes: this.chunkBytes,
      createdAt: new Date(transfer.createdAt).toISOString(),
      updatedAt: new Date(transfer.updatedAt).toISOString(),
      complete: transfer.receivedBytes === transfer.expectedBytes,
    };
  }

  commit(sessionId, transferId) {
    this.operations += 1;
    this.maybeSweep();
    const transfer = this.require(sessionId, transferId);
    const text = transfer.chunks.join("");
    const bytes = byteLength(text);
    if (bytes !== transfer.expectedBytes) {
      throw new CommandTransferError("COMMAND_TRANSFER_SIZE_MISMATCH", `Assembled ${bytes} bytes but expected ${transfer.expectedBytes}.`);
    }
    const digest = sha256Hex(text);
    if (digest !== transfer.expectedSha256) {
      throw new CommandTransferError("COMMAND_TRANSFER_HASH_MISMATCH", "Assembled command text does not match the declared sha256 digest.");
    }
    this.transfers.get(transfer.sessionId)?.delete(transfer.id);
    if (this.transfers.get(transfer.sessionId)?.size === 0) this.transfers.delete(transfer.sessionId);
    return { transferId: transfer.id, text, bytes, sha256: digest, command: transfer.command };
  }

  cancel(sessionId, transferId) {
    this.operations += 1;
    this.maybeSweep();
    const sessionIdKey = String(sessionId || "");
    const transfers = this.transfers.get(sessionIdKey);
    const existed = transfers ? transfers.delete(String(transferId || "")) : false;
    if (transfers && !transfers.size) this.transfers.delete(sessionIdKey);
    return { transferId: String(transferId || ""), cancelled: existed };
  }
}
