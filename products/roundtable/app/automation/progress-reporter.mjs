export function tailWindowForProgress(value, maxChars = 12000) {
  const text = String(value || "");
  const limit = Math.max(200, Math.floor(Number(maxChars) || 0));
  if (text.length <= limit) return { text, truncated: false, totalChars: text.length };
  return {
    text: `\u2026${text.slice(text.length - limit)}`,
    truncated: true,
    totalChars: text.length,
  };
}

export function normalizeProgressText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function createProgressReporter({ onProgress, now = () => Date.now(), throttleMs = 400 } = {}) {
  const interval = Math.max(0, Number(throttleMs) || 0);
  let lastEmittedText = "";
  let lastEmittedAt = Number.NEGATIVE_INFINITY;

  return {
    async report(snapshot = {}) {
      if (typeof onProgress !== "function") return false;
      const text = normalizeProgressText(snapshot.text);
      if (text.length < 2 || text === lastEmittedText) return false;
      const timestamp = Number(now());
      if (timestamp - lastEmittedAt < interval) return false;
      lastEmittedText = text;
      lastEmittedAt = timestamp;
      try {
        await onProgress({
          ...snapshot,
          text,
          at: snapshot.at || new Date(timestamp).toISOString(),
        });
      } catch {
        // UI progress is best-effort and must never stop final response capture.
      }
      return true;
    },
  };
}
