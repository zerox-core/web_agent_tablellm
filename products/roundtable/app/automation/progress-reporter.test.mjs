import assert from "node:assert/strict";
import test from "node:test";
import { createProgressReporter, normalizeProgressText, tailWindowForProgress } from "./progress-reporter.mjs";

test("normalizeProgressText strips carriage returns and collapses blank runs", () => {
  assert.equal(normalizeProgressText("  a\r\n\n\nb  \n"), "a\n\nb");
  assert.equal(normalizeProgressText(null), "");
});

test("tailWindowForProgress keeps short text intact", () => {
  const result = tailWindowForProgress("短文本", 12000);
  assert.deepEqual(result, { text: "短文本", truncated: false, totalChars: 3 });
});

test("tailWindowForProgress returns a bounded tail for long streaming text", () => {
  const text = "回".repeat(20000);
  const result = tailWindowForProgress(text, 12000);
  assert.equal(result.truncated, true);
  assert.equal(result.totalChars, 20000);
  assert.equal(result.text.length, 12001);
  assert.equal(result.text.charCodeAt(0), 0x2026);
  assert.equal(result.text.slice(1), text.slice(20000 - 12000));
});

test("tailWindowForProgress clamps the window to a sane minimum and tolerates junk input", () => {
  const result = tailWindowForProgress("x".repeat(500), 10);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 201);
  assert.deepEqual(tailWindowForProgress(null), { text: "", truncated: false, totalChars: 0 });
  assert.deepEqual(tailWindowForProgress(undefined, 0), { text: "", truncated: false, totalChars: 0 });
});

test("createProgressReporter throttles, dedupes, and never throws from onProgress", async () => {
  const emitted = [];
  let clock = 0;
  const reporter = createProgressReporter({
    now: () => clock,
    throttleMs: 400,
    onProgress: async (snapshot) => {
      emitted.push({ text: snapshot.text, at: snapshot.at });
      if (snapshot.text === "爆炸") throw new Error("boom");
    },
  });

  assert.equal(await reporter.report({ text: "第一" }), true);
  assert.equal(await reporter.report({ text: "第一" }), false);
  clock += 100;
  assert.equal(await reporter.report({ text: "更早节流内的更新" }), false);
  clock += 500;
  assert.equal(await reporter.report({ text: "  第二  \r\n" }), true);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].text, "第一");
  assert.equal(emitted[1].text, "第二");
  clock += 500;
  assert.equal(await reporter.report({ text: "爆炸" }), true);
  clock += 500;
  assert.equal(await reporter.report({ text: "炸后继续" }), true);
  assert.equal(await reporter.report({ text: "x" }), false);
  assert.equal(emitted.length, 4);
});
