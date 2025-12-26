import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 60;
const MCP_CONNECT_TIMEOUT_MS = 12_000;
const MCP_TOOL_TIMEOUT_MS = 20_000;
const URL_RESOLVE_TIMEOUT_MS = 12_000;

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function resolveFinalUrl(inputUrl, logger) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(inputUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    return res.url || inputUrl;
  } catch (err) {
    logger.warn("url resolve failed", { inputUrl, err: String(err) });
    return inputUrl;
  } finally {
    clearTimeout(timeout);
  }
}

function extractFromHash(urlObj, key) {
  const hash = urlObj.hash || "";
  const idx = hash.indexOf("?");
  if (idx === -1) return null;
  const qs = hash.slice(idx + 1);
  const sp = new URLSearchParams(qs);
  return sp.get(key);
}

function extractFeedIdAndToken(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }

  const xsecToken =
    u.searchParams.get("xsec_token") ||
    u.searchParams.get("xsecToken") ||
    extractFromHash(u, "xsec_token") ||
    extractFromHash(u, "xsecToken");

  const feedIdFromParams =
    u.searchParams.get("feed_id") ||
    u.searchParams.get("feedId") ||
    u.searchParams.get("note_id") ||
    u.searchParams.get("noteId") ||
    u.searchParams.get("id");

  let feedId = feedIdFromParams;
  if (!feedId) {
    const segments = u.pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const seg = segments[i];
      if (!seg) continue;
      if (["explore", "discovery", "item", "items"].includes(seg.toLowerCase())) continue;
      if (/^[0-9a-zA-Z]{8,}$/.test(seg)) {
        feedId = seg;
        break;
      }
    }
  }

  if (!feedId || !xsecToken) return null;
  return { feedId, xsecToken };
}

function safeToString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextFromToolResult(toolResult) {
  const content = toolResult?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function looksLikeNotFoundError(message) {
  const msg = String(message ?? "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("not found") ||
    msg.includes("notedetailmap") ||
    msg.includes("404") ||
    msg.includes("resource not found") ||
    msg.includes("不存在")
  );
}

function tryParseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizeImages(images) {
  const out = [];
  const list = Array.isArray(images) ? images : [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item) continue;

    if (typeof item === "string") {
      if (/^https?:\/\//i.test(item)) out.push({ id: `img_${i + 1}`, source: { kind: "url", url: item }, previewUrl: item });
      else if (/^data:image\//i.test(item))
        out.push({ id: `img_${i + 1}`, source: { kind: "dataUrl", dataUrl: item }, previewUrl: item });
      continue;
    }

    const url = item.url || item.src || item.urlDefault || item.urlPre || item.previewUrl || item.preview || item.link;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      const previewUrl = item.urlPre && /^https?:\/\//i.test(item.urlPre) ? item.urlPre : url;
      out.push({ id: `img_${i + 1}`, source: { kind: "url", url }, previewUrl });
      continue;
    }

    const data = item.data || item.base64 || item.dataUrl;
    const mimeType = item.mimeType || item.mime || "image/jpeg";
    if (typeof data === "string") {
      const dataUrl = data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
      out.push({ id: `img_${i + 1}`, source: { kind: "dataUrl", dataUrl }, previewUrl: dataUrl });
    }
  }
  return out;
}

function normalizePost({ sourceUrl, raw }) {
  const obj = raw && typeof raw === "object" ? raw : null;

  const feedDetailNote = obj?.data?.note;
  const feedDetailCaption =
    feedDetailNote && typeof feedDetailNote === "object"
      ? `${String(feedDetailNote.title ?? "").trim()}\n\n${String(feedDetailNote.desc ?? "").trim()}`.trim()
      : null;

  const caption =
    feedDetailCaption ||
    (obj && (obj.caption || obj.text || obj.description || obj.desc || obj.content)) ||
    (typeof raw === "string" ? raw : "") ||
    "";

  const images =
    (feedDetailNote && (feedDetailNote.imageList || feedDetailNote.images)) ||
    (obj && (obj.images || obj.imageUrls || obj.pictures || obj.photos || obj.media || obj.imgs)) ||
    [];

  return {
    sourceUrl,
    caption: String(caption ?? "").trim(),
    images: normalizeImages(images),
    raw,
  };
}

async function callToolWithFallbackArgs(client, toolName, url) {
  const candidates = [{ url }, { shareUrl: url }, { link: url }, { sourceUrl: url }];
  const perAttemptMs = Math.max(3000, Math.floor(MCP_TOOL_TIMEOUT_MS / candidates.length));
  let lastErr = null;
  for (const args of candidates) {
    try {
      return await withTimeout(client.callTool({ name: toolName, arguments: args }), perAttemptMs, "MCP callTool");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("MCP tool call failed");
}

async function detectToolName(client) {
  const tools = await withTimeout(client.listTools(), MCP_TOOL_TIMEOUT_MS, "MCP listTools");
  const names = (tools?.tools ?? []).map((t) => t.name).filter(Boolean);
  const preferred = ["get_feed_detail", "getContent", "get_content", "get-content", "get_post", "getPost", "get_note", "getNote"];
  for (const name of preferred) if (names.includes(name)) return name;
  const heuristic = names.find((n) => /get/i.test(n) && /(content|post|note|xhs)/i.test(n));
  if (heuristic) return heuristic;
  throw new Error(`Could not auto-detect a \"get content\" tool. Available tools: ${names.join(", ") || "(none)"}`);
}

async function detectUrlToolFallbackName(client) {
  const tools = await withTimeout(client.listTools(), MCP_TOOL_TIMEOUT_MS, "MCP listTools");
  const names = (tools?.tools ?? []).map((t) => t.name).filter(Boolean);
  const preferred = ["getContent", "get_content", "get-content", "get_post", "getPost", "get_note", "getNote"];
  for (const name of preferred) if (names.includes(name)) return name;
  const heuristic = names.find((n) => n !== "get_feed_detail" && /get/i.test(n) && /(content|post|note|xhs)/i.test(n));
  return heuristic || null;
}

export function createXhsClient({ logger, configStore }) {
  let connected = null; // { client, transport }
  let connecting = null;
  let detectedToolName = null;
  let connectSeq = 0;
  let connectedKey = null;
  const cache = new Map();
  let opCounter = 0;

  function pruneCache(now = Date.now()) {
    for (const [key, val] of cache.entries()) {
      if (!val || now - val.ts >= CACHE_TTL_MS) cache.delete(key);
    }
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }

  async function disconnect(reason) {
    connectSeq += 1;
    const current = connected;
    connected = null;
    detectedToolName = null;
    connectedKey = null;
    try {
      if (typeof current?.transport?.terminateSession === "function") {
        await current.transport.terminateSession().catch(() => {});
      }
      if (current?.transport) await current.transport.close();
    } catch (err) {
      logger.warn("mcp transport close failed", { reason, err: String(err) });
    }
  }

  function computeConnectionKey(cfg) {
    if (cfg.mcp.transport === "http") return `http:${cfg.mcp.httpUrl}`;
    return `stdio:${cfg.mcp.command} ${(cfg.mcp.args ?? []).join(" ")}`.trim();
  }

  async function connectNewClient() {
    const seq = connectSeq;
    const cfg = await configStore.getResolvedConfig();
    const key = computeConnectionKey(cfg);

    let transport;
    if (cfg.mcp.transport === "http") {
      const url = String(cfg.mcp.httpUrl || "").trim();
      if (!url) throw new Error("Missing MCP HTTP URL. Open Settings and set MCP HTTP URL.");
      transport = new StreamableHTTPClientTransport(new URL(url));
    } else {
      if (!cfg.mcp.command) {
        throw new Error("Missing MCP command. Open Settings and set MCP Command/Args for your XHS MCP server.");
      }
      transport = new StdioClientTransport({ command: cfg.mcp.command, args: cfg.mcp.args });
    }
    const client = new Client({ name: "xhs-recipe-extractor", version: "0.1.0" }, { capabilities: {} });
    await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, "MCP connect");
    if (seq !== connectSeq) {
      await transport.close().catch(() => {});
      throw new Error("MCP connection was reset during connect");
    }
    connected = { client, transport };
    connectedKey = key;
    logger.info("mcp connected", {
      transport: cfg.mcp.transport,
      httpUrl: cfg.mcp.transport === "http" ? cfg.mcp.httpUrl : undefined,
      command: cfg.mcp.transport === "stdio" ? cfg.mcp.command : undefined,
      args: cfg.mcp.transport === "stdio" ? cfg.mcp.args : undefined,
    });
    return connected;
  }

  async function getClient() {
    const cfg = await configStore.getResolvedConfig();
    const wantKey = computeConnectionKey(cfg);
    if (connected && connectedKey === wantKey) return connected.client;
    if (connected && connectedKey !== wantKey) await disconnect("config changed");
    if (!connecting) {
      connecting = connectNewClient().finally(() => {
        connecting = null;
      });
    }
    const c = await connecting;
    return c.client;
  }

  async function getPost(sourceUrl) {
    opCounter += 1;
    if (opCounter % 12 === 0) pruneCache();

    const cached = cache.get(sourceUrl);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.post;

    const finalUrl = await resolveFinalUrl(sourceUrl, logger);
    const client = await getClient();
    const cfg = await configStore.getResolvedConfig();
    const toolName = cfg.mcp.toolName ? String(cfg.mcp.toolName) : detectedToolName || (await detectToolName(client));
    if (!cfg.mcp.toolName) detectedToolName = toolName;

    let feedArgs = null;
    if (toolName === "get_feed_detail") {
      feedArgs = extractFeedIdAndToken(finalUrl);
      if (!feedArgs) {
        throw new Error(
          "Could not extract feed_id/xsec_token from this URL. Open the post in a browser and copy the full URL with xsec_token."
        );
      }
    }

    let toolResult;
    try {
      if (toolName === "get_feed_detail") {
        toolResult = await withTimeout(
          client.callTool({
            name: toolName,
            arguments: { feed_id: feedArgs.feedId, xsec_token: feedArgs.xsecToken, load_all_comments: false },
          }),
          MCP_TOOL_TIMEOUT_MS,
          "MCP callTool(get_feed_detail)"
        );
      } else {
        toolResult = await callToolWithFallbackArgs(client, toolName, finalUrl);
      }
    } catch (err) {
      logger.error("mcp tool call failed", { toolName, err: String(err) });
      // One reconnect retry in case the stdio server died or hung.
      try {
        await disconnect("tool call failed");
        const retryClient = await getClient();
        if (toolName === "get_feed_detail") {
          if (!feedArgs) throw err;
          toolResult = await withTimeout(
            retryClient.callTool({
              name: toolName,
              arguments: { feed_id: feedArgs.feedId, xsec_token: feedArgs.xsecToken, load_all_comments: false },
            }),
            MCP_TOOL_TIMEOUT_MS,
            "MCP callTool(get_feed_detail)"
          );
        } else {
          toolResult = await callToolWithFallbackArgs(retryClient, toolName, finalUrl);
        }
      } catch (err2) {
        throw new Error(`Fetch failed: MCP tool \"${toolName}\" error: ${String(err2?.message ?? err2)}`);
      }
    }

    if (toolResult?.isError) {
      const msg = extractTextFromToolResult(toolResult) || "MCP tool returned an error";
      if (toolName !== "get_feed_detail" && finalUrl !== sourceUrl && looksLikeNotFoundError(msg)) {
        try {
          logger.warn("mcp url-based tool failed with resolved URL; retrying with original URL", { toolName });
          const retryResult = await callToolWithFallbackArgs(await getClient(), toolName, sourceUrl);
          if (retryResult && !retryResult.isError) toolResult = retryResult;
        } catch (retryErr) {
          logger.warn("mcp retry with original URL failed", { err: String(retryErr) });
        }
      }
      if (!cfg.mcp.toolName && toolName === "get_feed_detail" && looksLikeNotFoundError(msg)) {
        try {
          const fallbackClient = await getClient();
          const alt = await detectUrlToolFallbackName(fallbackClient);
          if (alt) {
            logger.warn("mcp get_feed_detail failed; trying url-based tool fallback", { toolName, alt });
            const altResult = await callToolWithFallbackArgs(fallbackClient, alt, finalUrl);
            if (altResult && !altResult.isError) {
              detectedToolName = alt;
              toolResult = altResult;
            }
          }
        } catch (fallbackErr) {
          logger.warn("mcp fallback tool also failed", { err: String(fallbackErr) });
        }
      }

      if (toolResult?.isError) {
        const hint =
          "Fetch failed. The post may be deleted/private, or the URL token is missing/expired.\n" +
          "- Try opening the post in a browser and copying the full URL (with xsec_token).\n" +
          "- If you used an xhslink short link, try pasting the expanded www.xiaohongshu.com URL.";
        throw new Error(`${msg}\n\n${hint}`);
      }
    }

    const text = extractTextFromToolResult(toolResult);
    const parsed = tryParseJson(text);
    const raw = parsed ?? (text ? { caption: text } : toolResult);
    const post = normalizePost({ sourceUrl: finalUrl, raw });

    if (!post.caption && post.images.length === 0) {
      logger.warn("mcp returned empty post", { toolName, toolResult: safeToString(toolResult) });
    }

    cache.set(sourceUrl, { ts: Date.now(), post });
    pruneCache();
    return post;
  }

  return {
    getPost,
    disconnect: () => disconnect("manual"),
    shutdown: () => disconnect("shutdown"),
    resetSession: () => {
      cache.clear();
      detectedToolName = null;
      opCounter = 0;
      return disconnect("session reset");
    },
  };
}
