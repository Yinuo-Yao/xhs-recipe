import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const READY_POLL_INTERVAL_MS = 250;
const STARTUP_TIMEOUT_MS = 5_000;
const HEALTHCHECK_TIMEOUT_MS = 1_250;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function normalizePath(p) {
  return String(p ?? "").trim();
}

function classifySpawnError(err) {
  const code = String(err?.code ?? "");
  if (code === "ENOENT") return { code: "file_not_found" };
  if (code === "EACCES" || code === "EPERM") return { code: "permission" };
  return { code: "spawn_failed" };
}

function errorSummary(err) {
  const msg = String(err?.message ?? err);
  return msg.length > 600 ? `${msg.slice(0, 600)}…` : msg;
}

async function mcpHttpHealthCheck(httpUrl) {
  const transport = new StreamableHTTPClientTransport(new URL(httpUrl));
  const client = new Client({ name: "mcp-healthcheck", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    await client.listTools();
    return { ok: true };
  } finally {
    await transport.close().catch(() => {});
  }
}

function parseHostPort(httpUrl) {
  const u = new URL(httpUrl);
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const host = u.hostname || "localhost";
  return { host, port };
}

async function isTcpPortOpen({ host, port, timeoutMs }) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export function createMcpLauncher({ logger, configStore, emitStatus }) {
  let child = null;
  let childExePath = null;
  let status = { state: "idle", kind: "info", message: "Idle" };
  let ensurePromise = null;

  function setStatus(next) {
    status = { ...next, ts: new Date().toISOString() };
    try {
      emitStatus?.(status);
    } catch {
      // ignore
    }
  }

  function getStatus() {
    return status;
  }

  async function isReady(httpUrl) {
    return withTimeout(mcpHttpHealthCheck(httpUrl), HEALTHCHECK_TIMEOUT_MS, "MCP health check");
  }

  function stopChild(reason) {
    if (!child) return;
    try {
      child.removeAllListeners();
    } catch {
      // ignore
    }
    try {
      child.kill();
      logger.info("mcp stopped", { reason });
    } catch {
      // ignore
    }
    child = null;
    childExePath = null;
  }

  async function ensureStarted({ reason } = {}) {
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
      const cfg = await configStore.getResolvedConfig();
      if (cfg.mcp.transport !== "http") {
        setStatus({
          state: "disabled",
          kind: "info",
          message: "MCP auto-start disabled (Transport is Stdio).",
        });
        return getStatus();
      }

      const exePath = normalizePath(cfg.mcp.exePath);
      if (!exePath) {
        stopChild("no exePath");
        setStatus({
          state: "needs_path",
          kind: "warn",
          message: "Set MCP path to enable fetching.",
          actions: [{ id: "openSettings", label: "Open Settings" }],
        });
        return getStatus();
      }

      const httpUrl = normalizePath(cfg.mcp.httpUrl);
      if (!httpUrl) {
        setStatus({
          state: "error",
          kind: "error",
          message: "Missing MCP HTTP URL. Open Settings and set MCP HTTP URL.",
          actions: [{ id: "openSettings", label: "Open Settings" }],
        });
        return getStatus();
      }

      try {
        await fs.access(exePath);
      } catch {
        stopChild("exe missing");
        setStatus({
          state: "error",
          kind: "error",
          message: "MCP executable not found.",
          detail: exePath,
          actions: [{ id: "openSettings", label: "Open Settings" }],
        });
        return getStatus();
      }

      // If MCP is already reachable, don't spawn another instance.
      try {
        await isReady(httpUrl);
        setStatus({ state: "ready", kind: "info", message: "MCP ready." });
        return getStatus();
      } catch (err) {
        logger.info("mcp not ready yet", { reason, err: errorSummary(err) });
      }

      // If the port is already in use but MCP isn't responding, don't spawn a duplicate.
      const { host, port } = parseHostPort(httpUrl);
      const portOpen = await isTcpPortOpen({ host, port, timeoutMs: 350 });
      if (portOpen) {
        const startedAt = Date.now();
        let ok = false;
        while (Date.now() - startedAt < 1_250) {
          try {
            await isReady(httpUrl);
            ok = true;
            break;
          } catch {
            await sleep(READY_POLL_INTERVAL_MS);
          }
        }
        if (ok) {
          setStatus({ state: "ready", kind: "info", message: "MCP ready." });
          return getStatus();
        }
        stopChild("port already in use");
        setStatus({
          state: "error",
          kind: "error",
          code: "port_in_use",
          message: "Port is in use (or MCP HTTP URL is incorrect).",
          detail: `Update MCP HTTP URL/port in Settings (currently ${host}:${port}).`,
          actions: [{ id: "openSettings", label: "Open Settings" }],
        });
        return getStatus();
      }

      if (child && childExePath && childExePath !== exePath) {
        stopChild("exePath changed");
      }

      if (!child) {
        setStatus({ state: "starting", kind: "info", message: "Starting MCP…" });
        try {
          childExePath = exePath;
          child = spawn(exePath, [], {
            cwd: path.dirname(exePath),
            windowsHide: true,
            stdio: "ignore",
          });
          child.on("error", (err) => {
            const info = classifySpawnError(err);
            const actions = [{ id: "openSettings", label: "Open Settings" }];
            let message = "MCP failed to start.";
            let detail = errorSummary(err);
            if (info.code === "permission") {
              message = "Permission error starting MCP.";
              detail = "Try:\n- Unblock the file (Properties → Unblock)\n- Allow it in Windows Defender\n- Move it to a non-protected folder (e.g., Documents)";
            }
            setStatus({ state: "error", kind: "error", code: info.code, message, detail, actions });
          });
          child.on("exit", (code, signal) => {
            if (status.state === "ready") return;
            setStatus({
              state: "error",
              kind: "error",
              message: "MCP exited before becoming ready.",
              detail: `Exit code: ${code ?? "?"} Signal: ${signal ?? "?"}`,
              actions: [{ id: "openSettings", label: "Open Settings" }],
            });
          });
        } catch (err) {
          const info = classifySpawnError(err);
          setStatus({
            state: "error",
            kind: "error",
            code: info.code,
            message: "Failed to launch MCP.",
            detail: errorSummary(err),
            actions: [{ id: "openSettings", label: "Open Settings" }],
          });
          return getStatus();
        }
      } else {
        setStatus({ state: "starting", kind: "info", message: "Starting MCP…" });
      }

      const startedAt = Date.now();
      let lastErr = null;
      while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
        try {
          await isReady(httpUrl);
          setStatus({ state: "ready", kind: "info", message: "MCP ready." });
          return getStatus();
        } catch (err) {
          lastErr = err;
          await sleep(READY_POLL_INTERVAL_MS);
        }
      }

      const detail = lastErr ? errorSummary(lastErr) : "Timed out waiting for MCP.";
      setStatus({
        state: "error",
        kind: "error",
        code: "startup_timeout",
        message: "MCP failed to start.",
        detail,
        actions: [{ id: "openSettings", label: "Open Settings" }],
      });
      return getStatus();
    })().finally(() => {
      ensurePromise = null;
    });
    return ensurePromise;
  }

  function shutdown() {
    stopChild("app shutdown");
  }

  return {
    ensureStarted,
    getStatus,
    shutdown,
  };
}
