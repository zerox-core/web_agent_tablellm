import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CommandTransferError, CommandTransferRegistry } from "./command-transfer.mjs";

function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(String(text), "utf8")).digest("hex");
}

function chunkedOf(text, chunkChars) {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += chunkChars) {
    chunks.push(text.slice(offset, offset + chunkChars));
  }
  return chunks;
}

test("command transfer registry assembles chunked uploads and verifies size and sha256", () => {
  const registry = new CommandTransferRegistry({ chunkBytes: 4096 });
  const text = "第一段超长指令：圆桌请评审大文件链路。\n" + "讨论分块传输与断点恢复的安全边界。".repeat(1200);
  const bytes = Buffer.byteLength(text, "utf8");
  const expectedSha256 = sha256Hex(text);
  const command = { targets: ["chatgpt", "deepseek"], rounds: 3, mentionTokens: [] };

  const begin = registry.begin("session-a", { expectedBytes: bytes, expectedSha256, command });
  assert.equal(begin.chunkBytes, 4096);
  const chunks = chunkedOf(text, 1024);
  assert.ok(chunks.length > 10);
  let status = null;
  for (let index = 0; index < chunks.length; index += 1) {
    const result = registry.append("session-a", begin.transferId, { chunkIndex: index, content: chunks[index] });
    status = result;
  }
  assert.equal(status.complete, true);
  assert.equal(status.receivedBytes, bytes);

  const committed = registry.commit("session-a", begin.transferId);
  assert.equal(committed.text, text);
  assert.equal(committed.bytes, bytes);
  assert.equal(committed.sha256, expectedSha256);
  assert.deepEqual(committed.command, command);

  assert.throws(() => registry.status("session-a", begin.transferId), (error) => {
    assert.ok(error instanceof CommandTransferError);
    assert.equal(error.code, "COMMAND_TRANSFER_NOT_FOUND");
    return true;
  });
});

test("command transfer status reports resume state for partial uploads", () => {
  const registry = new CommandTransferRegistry({ chunkBytes: 4096 });
  const text = "恢复测试" + "内容".repeat(1500);
  const bytes = Buffer.byteLength(text, "utf8");
  const begin = registry.begin("session-a", { expectedBytes: bytes, expectedSha256: sha256Hex(text) });
  const chunks = chunkedOf(text, 1024);
  registry.append("session-a", begin.transferId, { chunkIndex: 0, content: chunks[0] });
  registry.append("session-a", begin.transferId, { chunkIndex: 1, content: chunks[1] });

  const status = registry.status("session-a", begin.transferId);
  assert.equal(status.receivedChunks, 2);
  assert.equal(status.complete, false);
  assert.equal(status.transferId, begin.transferId);

  for (let index = 2; index < chunks.length; index += 1) {
    registry.append("session-a", begin.transferId, { chunkIndex: index, content: chunks[index] });
  }
  const committed = registry.commit("session-a", begin.transferId);
  assert.equal(committed.text, text);
});

test("command transfer registry rejects invalid declarations and duplicate command text", () => {
  const registry = new CommandTransferRegistry({ chunkBytes: 4096 });
  const text = "小指令";
  const bytes = Buffer.byteLength(text, "utf8");
  const digest = sha256Hex(text);

  assert.throws(() => registry.begin("session-a", { expectedBytes: 0, expectedSha256: digest }), (error) => error.code === "INVALID_COMMAND_TRANSFER");
  assert.throws(() => registry.begin("session-a", { expectedBytes: 1.5, expectedSha256: digest }), (error) => error.code === "INVALID_COMMAND_TRANSFER");
  assert.throws(() => registry.begin("session-a", { expectedBytes: bytes, expectedSha256: "nothex" }), (error) => error.code === "INVALID_COMMAND_TRANSFER");
  assert.throws(() => registry.begin("session-a", { expectedBytes: bytes, expectedSha256: digest, command: { text: "夹带私货" } }), (error) => error.code === "INVALID_COMMAND_TRANSFER");
  assert.throws(() => registry.begin("session-a", { expectedBytes: 33 * 1024 * 1024, expectedSha256: digest }), (error) => error.code === "COMMAND_TRANSFER_TOO_LARGE");
});

test("command transfer registry enforces chunk order, chunk cap, and declared size", () => {
  const registry = new CommandTransferRegistry({ chunkBytes: 4096 });
  const text = "顺序校验" + "字节".repeat(1000);
  const bytes = Buffer.byteLength(text, "utf8");
  const begin = registry.begin("session-a", { expectedBytes: bytes, expectedSha256: sha256Hex(text) });

  assert.throws(
    () => registry.append("session-a", begin.transferId, { chunkIndex: 2, content: "跳跃" }),
    (error) => error.code === "COMMAND_TRANSFER_CHUNK_OUT_OF_ORDER",
  );
  const oversized = "x".repeat(4097);
  assert.throws(
    () => registry.append("session-a", begin.transferId, { chunkIndex: 0, content: oversized }),
    (error) => error.code === "COMMAND_TRANSFER_TOO_LARGE",
  );

  const shortText = "只声明一个块";
  const shortBegin = registry.begin("session-b", { expectedBytes: Buffer.byteLength(shortText, "utf8"), expectedSha256: sha256Hex(shortText + "多余") });
  assert.throws(
    () => registry.append("session-b", shortBegin.transferId, { chunkIndex: 0, content: shortText + "超了" }),
    (error) => error.code === "COMMAND_TRANSFER_SIZE_EXCEEDED",
  );
});

test("command transfer commit verifies the assembled digest and rejects incomplete uploads", () => {
  const registry = new CommandTransferRegistry({ chunkBytes: 4096 });
  const text = "完整性" + "校验".repeat(400);
  const bytes = Buffer.byteLength(text, "utf8");

  const mismatchBegin = registry.begin("session-a", { expectedBytes: bytes, expectedSha256: sha256Hex("别的文本") });
  for (const [index, chunk] of chunkedOf(text, 1024).entries()) {
    registry.append("session-a", mismatchBegin.transferId, { chunkIndex: index, content: chunk });
  }
  assert.throws(
    () => registry.commit("session-a", mismatchBegin.transferId),
    (error) => error.code === "COMMAND_TRANSFER_HASH_MISMATCH",
  );

  const partialText = "不完整上传";
  const partialBegin = registry.begin("session-b", { expectedBytes: bytes, expectedSha256: sha256Hex(text) });
  registry.append("session-b", partialBegin.transferId, { chunkIndex: 0, content: partialText });
  assert.throws(
    () => registry.commit("session-b", partialBegin.transferId),
    (error) => error.code === "COMMAND_TRANSFER_SIZE_MISMATCH",
  );
});

test("command transfers are isolated per session, cancellable, and expire after the ttl", () => {
  let clock = 1_000_000;
  const registry = new CommandTransferRegistry({ chunkBytes: 4096, ttlMs: 1000, now: () => clock });
  const text = "隔离与过期";
  const bytes = Buffer.byteLength(text, "utf8");
  const begin = registry.begin("session-a", { expectedBytes: bytes, expectedSha256: sha256Hex(text) });

  assert.throws(() => registry.status("session-b", begin.transferId), (error) => error.code === "COMMAND_TRANSFER_NOT_FOUND");
  assert.throws(() => registry.append("session-b", begin.transferId, { chunkIndex: 0, content: text }), (error) => error.code === "COMMAND_TRANSFER_NOT_FOUND");

  const cancelled = registry.cancel("session-a", begin.transferId);
  assert.deepEqual(cancelled, { transferId: begin.transferId, cancelled: true });
  const cancelledAgain = registry.cancel("session-a", begin.transferId);
  assert.deepEqual(cancelledAgain, { transferId: begin.transferId, cancelled: false });

  const second = registry.begin("session-a", { expectedBytes: bytes, expectedSha256: sha256Hex(text) });
  clock += 2000;
  assert.throws(() => registry.status("session-a", second.transferId), (error) => error.code === "COMMAND_TRANSFER_NOT_FOUND");
});
