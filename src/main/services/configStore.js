import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_MCP_HTTP_URL = "http://localhost:18060/mcp";
const DEFAULT_MCP_TRANSPORT = "http";
const DEFAULT_OUTPUT_LANGUAGE = "zh-Hans";

const ConfigSchema = z.object({
  openai: z
    .object({
      model: z.string().default(DEFAULT_OPENAI_MODEL),
    })
    .default({}),
  mcp: z
    .object({
      transport: z.enum(["stdio", "http"]).default(DEFAULT_MCP_TRANSPORT),
      exePath: z.string().default(""),
      command: z.string().default(""),
      args: z.array(z.string()).default([]),
      httpUrl: z.string().url().default(DEFAULT_MCP_HTTP_URL),
      toolName: z.string().default(""),
    })
    .default({}),
  ui: z
    .object({
      outputLanguage: z.enum(["zh-Hans", "en"]).default(DEFAULT_OUTPUT_LANGUAGE),
    })
    .default({}),
  recentUrls: z.array(z.string()).default([]),
});

function parseArgsString(input) {
  const str = String(input ?? "").trim();
  if (!str) return [];

  const out = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) out.push(current), (current = "");
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error("Unclosed quote in MCP Args");
  if (current) out.push(current);
  return out;
}

function tryValidateUrl(url) {
  try {
    // eslint-disable-next-line no-new
    new URL(String(url));
    return true;
  } catch {
    return false;
  }
}

export function createConfigStore({ app }) {
  const state = {
    loaded: false,
    configPath: null,
    config: ConfigSchema.parse({}),
  };

  function getConfigPath() {
    if (state.configPath) return state.configPath;
    state.configPath = path.join(app.getPath("userData"), "config.json");
    return state.configPath;
  }

  async function load() {
    const cfgPath = getConfigPath();
    try {
      const raw = await fs.readFile(cfgPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.mcp && parsed.mcp.transport == null && parsed.mcp.command) parsed.mcp.transport = "stdio";
      state.config = ConfigSchema.parse(parsed);
    } catch (err) {
      if (String(err?.code) !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn("config load failed; using defaults", err);
      }
      state.config = ConfigSchema.parse({});
      await save();
    }
    state.loaded = true;
  }

  async function save() {
    const cfgPath = getConfigPath();
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(state.config, null, 2), "utf8");
  }

  function applyEnvDefaults(config) {
    const out = structuredClone(config);

    if (process.env.OPENAI_MODEL && (!out.openai.model || out.openai.model === DEFAULT_OPENAI_MODEL)) {
      out.openai.model = process.env.OPENAI_MODEL;
    }

    if (process.env.XHS_MCP_TRANSPORT && out.mcp.transport === DEFAULT_MCP_TRANSPORT) {
      const t = String(process.env.XHS_MCP_TRANSPORT).toLowerCase();
      if (t === "http" || t === "stdio") out.mcp.transport = t;
    }
    if (!out.mcp.command && process.env.XHS_MCP_COMMAND) out.mcp.command = process.env.XHS_MCP_COMMAND;
    if ((!out.mcp.args || out.mcp.args.length === 0) && process.env.XHS_MCP_ARGS) {
      try {
        out.mcp.args = parseArgsString(process.env.XHS_MCP_ARGS);
      } catch {
        // ignore invalid env var
      }
    }
    const envHttpUrl = process.env.XHS_MCP_URL || process.env.XHS_MCP_HTTP_URL;
    if (envHttpUrl && (!out.mcp.httpUrl || out.mcp.httpUrl === DEFAULT_MCP_HTTP_URL)) {
      const candidate = String(envHttpUrl).trim();
      if (tryValidateUrl(candidate)) out.mcp.httpUrl = candidate;
    }
    if (!out.mcp.toolName && process.env.XHS_MCP_TOOL) out.mcp.toolName = process.env.XHS_MCP_TOOL;

    return out;
  }

  async function getResolvedConfig() {
    return applyEnvDefaults(state.config);
  }

  async function getOpenAIApiKey() {
    return process.env.OPENAI_API_KEY ? String(process.env.OPENAI_API_KEY) : null;
  }

  function getPublicConfig() {
    const cfg = applyEnvDefaults(state.config);
    return {
      openai: { model: cfg.openai.model, hasApiKey: Boolean(process.env.OPENAI_API_KEY) },
      mcp: {
        transport: cfg.mcp.transport,
        exePath: cfg.mcp.exePath,
        command: cfg.mcp.command,
        args: cfg.mcp.args,
        httpUrl: cfg.mcp.httpUrl,
        toolName: cfg.mcp.toolName,
      },
      ui: { outputLanguage: cfg.ui.outputLanguage },
      recentUrls: cfg.recentUrls,
    };
  }

  async function applyPatch(patch) {
    const next = structuredClone(state.config);
    if (patch?.openai?.model != null) next.openai.model = String(patch.openai.model);
    if (patch?.ui?.outputLanguage != null) next.ui.outputLanguage = patch.ui.outputLanguage === "en" ? "en" : "zh-Hans";
    if (patch?.mcp?.exePath != null) next.mcp.exePath = String(patch.mcp.exePath).trim();
    if (patch?.mcp?.command != null) next.mcp.command = String(patch.mcp.command);
    if (patch?.mcp?.args != null) next.mcp.args = Array.isArray(patch.mcp.args) ? patch.mcp.args.map(String) : parseArgsString(patch.mcp.args);
    if (patch?.mcp?.transport != null) next.mcp.transport = patch.mcp.transport === "http" ? "http" : "stdio";
    if (patch?.mcp?.httpUrl != null) next.mcp.httpUrl = String(patch.mcp.httpUrl).trim();
    if (patch?.mcp?.toolName != null) next.mcp.toolName = String(patch.mcp.toolName);
    if (patch?.recentUrls != null) {
      next.recentUrls = Array.isArray(patch.recentUrls) ? patch.recentUrls.map(String) : next.recentUrls;
      next.recentUrls = Array.from(new Set(next.recentUrls)).slice(0, 20);
    }

    state.config = ConfigSchema.parse(next);
    await save();
  }

  return {
    load,
    save,
    applyPatch,
    getResolvedConfig,
    getOpenAIApiKey,
    getPublicConfig,
    getConfigPath,
  };
}
