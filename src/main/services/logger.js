import fs from "node:fs/promises";
import path from "node:path";

export function createLogger({ app }) {
  const entries = [];
  const maxEntries = 400;
  const flushIntervalMs = 350;
  const pendingLines = [];
  let flushTimer = null;
  let flushing = false;

  function getLogsFolderPath() {
    try {
      return path.join(app.getPath("userData"), "logs");
    } catch {
      return null;
    }
  }

  async function appendToFileBatch(lines) {
    const folder = getLogsFolderPath();
    if (!folder) return;
    const filePath = path.join(folder, "app.log");
    try {
      await fs.mkdir(folder, { recursive: true });
      await fs.appendFile(filePath, lines.join(""), "utf8");
    } catch {
      // ignore disk logging failures
    }
  }

  async function flush() {
    if (flushing) return;
    if (pendingLines.length === 0) return;
    flushing = true;
    try {
      const batch = pendingLines.splice(0, pendingLines.length);
      await appendToFileBatch(batch);
    } finally {
      flushing = false;
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushIntervalMs);
    flushTimer.unref?.();
  }

  function push(level, message, data) {
    const ts = new Date().toISOString();
    const entry = { ts, level, message, data: data ?? null };
    entries.push(entry);
    while (entries.length > maxEntries) entries.shift();
    pendingLines.push(`${ts} [${level}] ${message}${data ? ` ${JSON.stringify(data)}` : ""}\n`);
    scheduleFlush();
  }

  return {
    getLogsFolderPath,
    getEntries: () => entries.slice(),
    flush,
    info: (message, data) => push("info", message, data),
    warn: (message, data) => push("warn", message, data),
    error: (message, data) => push("error", message, data),
    debug: (message, data) => push("debug", message, data),
  };
}
