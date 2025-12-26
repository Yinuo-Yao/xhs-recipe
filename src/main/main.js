import "dotenv/config";
import { app, BrowserWindow, clipboard, dialog, nativeImage, shell, net } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";

import { createConfigStore } from "./services/configStore.js";
import { createLogger } from "./services/logger.js";
import { createMcpLauncher } from "./services/mcpLauncher.js";
import { createXhsClient } from "./services/xhsClient.js";
import { createOpenAIClient } from "./services/openaiClient.js";
import { buildSystemPrompt, buildUserPrompt } from "./services/prompt.js";
import { normalizeMarkdownRecipe } from "./services/recipeFormatter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGE_DOWNLOAD_TIMEOUT_MS = 20_000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_DIM = 1280;
const IMAGE_JPEG_QUALITY = 82;
const PREVIEW_MAX_DIM = 360;
const PREVIEW_JPEG_QUALITY = 75;
const PREVIEW_CACHE_MAX = 120;

const ABORTED = Object.freeze({ __aborted: true });

function toOutcome(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#0f0f10",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

function bufferToDataUrl(buffer, mimeType) {
  const b64 = Buffer.from(buffer).toString("base64");
  return `data:${mimeType};base64,${b64}`;
}

async function readResponseBodyWithLimit(res, maxBytes) {
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`image too large (${declared} bytes)`);
    }
  }

  const reader = res.body?.getReader?.();
  if (!reader) {
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) throw new Error(`image too large (${arrayBuffer.byteLength} bytes)`);
    return Buffer.from(arrayBuffer);
  }

  const chunks = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error(`image too large (>${maxBytes} bytes)`);
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function downloadImageViaNet(url, { logger, referer, signal }) {
  const maxBytes = IMAGE_MAX_BYTES;

  async function doRequest(targetUrl, redirectsLeft) {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let abortListener = null;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          req.abort();
        } catch {
          // ignore
        }
        cleanup();
        reject(new Error(`image download failed (net): timeout after ${IMAGE_DOWNLOAD_TIMEOUT_MS}ms`));
      }, IMAGE_DOWNLOAD_TIMEOUT_MS);

      function cleanup() {
        clearTimeout(timeoutId);
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      }

      if (signal) {
        if (signal.aborted) {
          cleanup();
          reject(new Error("Request aborted"));
          return;
        }
        abortListener = () => {
          try {
            req.abort();
          } catch {
            // ignore
          }
          cleanup();
          reject(new Error("Request aborted"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }

      const req = net.request({
        method: "GET",
        url: targetUrl,
      });

      req.setHeader(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
      );
      req.setHeader("Accept", "image/jpeg,image/png,image/webp,image/apng,image/*;q=0.8,*/*;q=0.5");
      req.setHeader("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
      if (referer) req.setHeader("Referer", referer);
      req.setHeader("Origin", "https://www.xiaohongshu.com");

      req.on("response", (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
          cleanup();
          res.destroy();
          const nextUrl = new URL(location, targetUrl).toString();
          doRequest(nextUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          cleanup();
          res.destroy();
          reject(new Error(`image download failed (net): HTTP ${status}`));
          return;
        }

        const contentType = String(res.headers["content-type"] ?? "application/octet-stream");
        const contentLength = res.headers["content-length"] ? Number(res.headers["content-length"]) : null;
        if (contentLength && Number.isFinite(contentLength) && contentLength > maxBytes) {
          cleanup();
          res.destroy();
          reject(new Error(`image too large (${contentLength} bytes)`));
          return;
        }

        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          if (timedOut) return;
          const buf = Buffer.from(chunk);
          total += buf.length;
          if (total > maxBytes) {
            clearTimeout(timeoutId);
            res.destroy();
            reject(new Error(`image too large (>${maxBytes} bytes)`));
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          cleanup();
          resolve({ buffer: Buffer.concat(chunks, total), contentType });
        });
        res.on("error", (err) => {
          cleanup();
          reject(err);
        });
      });

      req.on("error", (err) => {
        cleanup();
        reject(err);
      });
      req.end();
    });
  }

  try {
    return await doRequest(url, 5);
  } catch (err) {
    logger.warn("image download failed (net)", { url, err: String(err) });
    return null;
  }
}

function isAbortError(err) {
  if (!err) return false;
  const name = String(err?.name ?? "");
  const msg = String(err?.message ?? err);
  return name === "AbortError" || msg === "Request aborted" || msg.includes("aborted");
}

async function downloadImage(url, logger, { referer, signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);
  let abortListener = null;
  if (signal) {
    if (signal.aborted) controller.abort();
    abortListener = () => controller.abort();
    signal.addEventListener("abort", abortListener, { once: true });
  }
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Referer: referer || "https://www.xiaohongshu.com/",
        Origin: "https://www.xiaohongshu.com",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "image/jpeg,image/png,image/webp,image/apng,image/*;q=0.8,*/*;q=0.5",
      },
    });
    if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    if (!/^image\//i.test(contentType) && !/^application\/octet-stream/i.test(contentType)) {
      throw new Error(`unexpected content-type: ${contentType}`);
    }
    const buffer = await readResponseBodyWithLimit(res, IMAGE_MAX_BYTES);
    return { buffer, contentType };
  } catch (err) {
    if (controller.signal.aborted || signal?.aborted || isAbortError(err)) throw err;
    logger.warn("image download failed", { url, err: String(err) });
    return await downloadImageViaNet(url, { logger, referer, signal });
  } finally {
    clearTimeout(timeout);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function preprocessImageForOpenAI({ buffer, contentType }, logger) {
  try {
    const img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) {
      const mime = String(contentType ?? "application/octet-stream").split(";")[0].trim();
      return bufferToDataUrl(buffer, mime || "application/octet-stream");
    }

    const { width, height } = img.getSize();
    const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(width || 1, height || 1));
    const resized = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img;

    const jpg = resized.toJPEG(IMAGE_JPEG_QUALITY);
    return bufferToDataUrl(jpg, "image/jpeg");
  } catch (err) {
    logger.warn("image preprocess failed; sending original", { err: String(err), contentType });
    const mime = String(contentType ?? "application/octet-stream").split(";")[0].trim();
    return bufferToDataUrl(buffer, mime || "application/octet-stream");
  }
}

function makePreviewDataUrlFromNativeImage(img) {
  if (!img || img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scale = Math.min(1, PREVIEW_MAX_DIM / Math.max(width || 1, height || 1));
  const resized = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img;
  const jpg = resized.toJPEG(PREVIEW_JPEG_QUALITY);
  return bufferToDataUrl(jpg, "image/jpeg");
}

const XhsFetchSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(5000)
    .refine((s) => /^https?:\/\//i.test(s), { message: "URL must start with http(s)://" }),
  requestId: z.string().min(1).max(200).optional(),
});

const ImagePrimarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().min(1).max(5000) }),
  z.object({ kind: z.literal("dataUrl"), dataUrl: z.string().min(1).max(5_000_000) }),
]);

const GenerateRecipeSchema = z.object({
  sourceUrl: z.string().min(1).max(5000),
  caption: z.string().max(200_000),
  images: z.array(ImagePrimarySchema).max(40).optional(),
  requestId: z.string().min(1).max(200).optional(),
});

const AbortRequestSchema = z.object({ requestId: z.string().min(1).max(200) }).strict();

const ConfigPatchSchema = z
  .object({
    openai: z
      .object({
        model: z.string().min(1).max(200).optional(),
      })
      .optional(),
    mcp: z
      .object({
        transport: z.enum(["stdio", "http"]).optional(),
        exePath: z.string().optional(),
        command: z.string().optional(),
        args: z.union([z.array(z.string()), z.string()]).optional(),
        httpUrl: z.string().url().optional(),
        toolName: z.string().optional(),
      })
      .optional(),
    ui: z
      .object({
        outputLanguage: z.enum(["zh-Hans", "en"]).optional(),
      })
      .optional(),
    recentUrls: z.array(z.string()).optional(),
  })
  .strict();

const CopySchema = z.object({ text: z.string() }).strict();
const ExportSchema = z.object({ markdown: z.string(), suggestedName: z.string().optional() }).strict();

async function main() {
  await app.whenReady();

  const configStore = createConfigStore({ app });
  await configStore.load();

  const logger = createLogger({ app, configStore });
  logger.info("app ready", {
    version: app.getVersion(),
    build: process.env.APP_BUILD ?? process.env.GIT_SHA ?? null,
    electron: process.versions.electron,
    node: process.versions.node,
  });

  const xhsClient = createXhsClient({ logger, configStore });
  const win = createMainWindow();
  const previewCache = new Map(); // key -> { ts, dataUrl }
  const inFlightRequests = new Map(); // requestId -> { kind, controller }
  const mcpLauncher = createMcpLauncher({
    logger,
    configStore,
    emitStatus: (s) => {
      try {
        if (!win.isDestroyed()) win.webContents.send("mcp:status", s);
      } catch {
        // ignore
      }
    },
  });

  const { ipcMain } = await import("electron");

  ipcMain.handle("mcp:getStatus", async () => mcpLauncher.getStatus());

  ipcMain.handle("dialog:pickMcpExecutable", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Select MCP Executable",
      properties: ["openFile"],
      filters: [
        { name: "Executable", extensions: ["exe"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (res.canceled) return { canceled: true };
    const filePath = Array.isArray(res.filePaths) && res.filePaths[0] ? res.filePaths[0] : null;
    return { canceled: false, filePath };
  });

  ipcMain.handle("request:abort", async (_e, payload) => {
    const parsed = AbortRequestSchema.parse(payload);
    const entry = inFlightRequests.get(parsed.requestId);
    if (!entry) return { ok: false, notFound: true };
    try {
      entry.controller.abort();
    } catch {
      // ignore
    }
    if (entry.kind === "fetch") {
      await xhsClient.disconnect?.().catch(() => {});
    }
    return { ok: true };
  });

  ipcMain.handle("request:abortAll", async () => {
    const ids = Array.from(inFlightRequests.keys());
    for (const id of ids) {
      const entry = inFlightRequests.get(id);
      if (!entry) continue;
      try {
        entry.controller.abort();
      } catch {
        // ignore
      }
    }
    await xhsClient.disconnect?.().catch(() => {});
    return { ok: true, aborted: ids.length };
  });

  ipcMain.handle("session:clear", async () => {
    await xhsClient.resetSession?.().catch(() => {});
    return { ok: true };
  });

  void mcpLauncher.ensureStarted({ reason: "startup" });

  ipcMain.handle("config:get", async () => configStore.getPublicConfig());
  ipcMain.handle("config:save", async (_e, patch) => {
    const parsed = ConfigPatchSchema.parse(patch);
    await configStore.applyPatch(parsed);
    void mcpLauncher.ensureStarted({ reason: "config_save" });
    return configStore.getPublicConfig();
  });

  ipcMain.handle("logs:get", async () => logger.getEntries());
  ipcMain.handle("logs:openFolder", async () => {
    const folder = logger.getLogsFolderPath();
    if (folder) await shell.openPath(folder);
    return { folder };
  });

  ipcMain.handle("xhs:fetchPost", async (_e, payload) => {
    const parsed = XhsFetchSchema.parse(payload);
    logger.info("fetch start", { url: parsed.url });

    const requestId = parsed.requestId || crypto.randomUUID();
    const controller = new AbortController();
    inFlightRequests.set(requestId, { kind: "fetch", controller });

    try {
      const abortPromise = new Promise((resolve) => {
        if (controller.signal.aborted) return resolve(ABORTED);
        controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
      });

      const winner = await Promise.race([toOutcome(xhsClient.getPost(parsed.url)), toOutcome(abortPromise)]);
      if (winner.ok && winner.value?.__aborted) {
        await xhsClient.disconnect?.().catch(() => {});
        throw new Error("Request aborted");
      }
      if (!winner.ok) throw winner.error;
      const post = winner.value;
      logger.info("fetch done", { url: parsed.url, images: post.images.length, captionLen: post.caption.length });
      return post;
    } finally {
      inFlightRequests.delete(requestId);
    }
  });

  ipcMain.handle("images:previews", async (_e, { images }) => {
    const list = Array.isArray(images) ? images : [];
    const out = [];

    function cacheSet(key, dataUrl) {
      previewCache.set(key, { ts: Date.now(), dataUrl });
      while (previewCache.size > PREVIEW_CACHE_MAX) {
        const oldestKey = previewCache.keys().next().value;
        if (oldestKey === undefined) break;
        previewCache.delete(oldestKey);
      }
    }

    const errors = [];
    for (const img of list) {
      const id = String(img?.id ?? "");
      const source = img?.source;
      if (!id || !source?.kind) continue;

      if (source.kind === "dataUrl" && typeof source.dataUrl === "string") {
        try {
          const ni = nativeImage.createFromDataURL(source.dataUrl);
          const preview = makePreviewDataUrlFromNativeImage(ni) ?? source.dataUrl;
          out.push({ id, dataUrl: preview });
        } catch {
          out.push({ id, dataUrl: source.dataUrl });
        }
        continue;
      }

      if (source.kind === "url" && typeof source.url === "string") {
        const key = `url:${source.url}`;
        const cached = previewCache.get(key);
        if (cached?.dataUrl) {
          out.push({ id, dataUrl: cached.dataUrl });
          continue;
        }

        const downloaded = await downloadImage(source.url, logger);
        if (!downloaded) {
          errors.push({ id, reason: "download_failed" });
          continue;
        }
        const ni = nativeImage.createFromBuffer(downloaded.buffer);
        const preview =
          makePreviewDataUrlFromNativeImage(ni) ||
          bufferToDataUrl(downloaded.buffer, String(downloaded.contentType ?? "application/octet-stream").split(";")[0].trim());
        if (!preview) {
          errors.push({ id, reason: "decode_failed" });
          continue;
        }
        cacheSet(key, preview);
        out.push({ id, dataUrl: preview });
      }
    }

    if (errors.length) logger.warn("image previews incomplete", { ok: out.length, errors: errors.slice(0, 8) });
    return { previews: out };
  });

  ipcMain.handle("openai:generateRecipe", async (_e, payload) => {
    const parsed = GenerateRecipeSchema.parse({
      ...(payload ?? {}),
      images: Array.isArray(payload?.images) ? payload.images : [],
    });
    const cfg = await configStore.getResolvedConfig();
    const apiKey = await configStore.getOpenAIApiKey();
    if (!apiKey) throw new Error("Missing OpenAI API key. Set OPENAI_API_KEY in .env.");

    const requestId = parsed.requestId || crypto.randomUUID();
    const controller = new AbortController();
    inFlightRequests.set(requestId, { kind: "generate", controller });

    try {
      const abortPromise = new Promise((resolve) => {
        if (controller.signal.aborted) return resolve(ABORTED);
        controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
      });
      const abortOutcome = toOutcome(abortPromise);

      const requested = parsed.images ?? [];
      const imageDataUrls = [];
      const failures = [];
      for (const img of requested) {
        if (controller.signal.aborted) throw new Error("Request aborted");
        if (img.kind === "dataUrl" && img.dataUrl) {
          imageDataUrls.push(img.dataUrl);
          continue;
        }
        if (img.kind === "url" && img.url) {
          const downloadWinner = await Promise.race([
            toOutcome(downloadImage(img.url, logger, { referer: parsed.sourceUrl, signal: controller.signal })),
            abortOutcome,
          ]);
          if (downloadWinner.ok && downloadWinner.value?.__aborted) throw new Error("Request aborted");
          if (!downloadWinner.ok) throw downloadWinner.error;
          const downloaded = downloadWinner.value;
          if (!downloaded) {
            failures.push({ kind: "url", url: img.url, reason: "download_failed" });
            continue;
          }
          const processed = preprocessImageForOpenAI(downloaded, logger);
          if (!processed) {
            failures.push({ kind: "url", url: img.url, reason: "preprocess_failed" });
            continue;
          }
          imageDataUrls.push(processed);
        }
      }

      logger.info("openai generate start", { model: cfg.openai.model, images: imageDataUrls.length });
      const openaiClient = createOpenAIClient({ logger, apiKey, model: cfg.openai.model });
      const systemPrompt = buildSystemPrompt({ outputLanguage: cfg.ui?.outputLanguage });
      const userPrompt = buildUserPrompt({ sourceUrl: parsed.sourceUrl, caption: parsed.caption });
      async function runModel(modelName) {
        const client = modelName === cfg.openai.model ? openaiClient : createOpenAIClient({ logger, apiKey, model: modelName });
        const winner = await Promise.race([
          toOutcome(
            client.generateRecipeMarkdown({
              systemPrompt,
              userPrompt,
              imageDataUrls,
              signal: controller.signal,
            })
          ),
          abortOutcome,
        ]);
        if (winner.ok && winner.value?.__aborted) throw new Error("Request aborted");
        if (!winner.ok) throw winner.error;
        return winner.value;
      }

      let markdown;
      try {
        markdown = await runModel(cfg.openai.model);
      } catch (err) {
        const msg = String(err?.message ?? err);
        const isBlank = msg.includes("blank content") || msg.includes("no content") || msg.includes("incomplete (max_output_tokens)");
        if (!isBlank || !/^gpt-5/i.test(cfg.openai.model)) throw err;
        const fallbackModel = "gpt-4o-mini";
        logger.warn("openai primary model returned empty; retrying with fallback model", { primary: cfg.openai.model, fallback: fallbackModel });
        markdown = await runModel(fallbackModel);
      }

      const normalized = normalizeMarkdownRecipe(markdown);
      logger.info("openai generate done", { chars: normalized.length });
      return {
        markdown: normalized,
        meta: { images: { requested: requested.length, attached: imageDataUrls.length, failures } },
      };
    } finally {
      inFlightRequests.delete(requestId);
    }
  });

  ipcMain.handle("output:copy", async (_e, { text }) => {
    const parsed = CopySchema.parse({ text });
    clipboard.writeText(parsed.text);
    return { ok: true };
  });

  ipcMain.handle("output:exportMarkdown", async (_e, { markdown, suggestedName }) => {
    const parsed = ExportSchema.parse({ markdown, suggestedName });
    const safeName = String(parsed.suggestedName ?? "recipe").replace(/[<>:\"/\\|?*\u0000-\u001F]/g, "_");
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Export Recipe Markdown",
      defaultPath: `${safeName}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await fs.writeFile(filePath, parsed.markdown, "utf8");
    return { canceled: false, filePath };
  });

  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    Promise.allSettled([xhsClient.shutdown?.(), mcpLauncher.shutdown?.(), logger.flush?.()]).finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  app.quit();
});
