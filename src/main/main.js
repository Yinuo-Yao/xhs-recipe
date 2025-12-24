import "dotenv/config";
import { app, BrowserWindow, clipboard, dialog, nativeImage, shell, net } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { z } from "zod";

import { createConfigStore } from "./services/configStore.js";
import { createLogger } from "./services/logger.js";
import { createXhsClient } from "./services/xhsClient.js";
import { createOpenAIClient } from "./services/openaiClient.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./services/prompt.js";
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

async function downloadImageViaNet(url, { logger, referer }) {
  const maxBytes = IMAGE_MAX_BYTES;

  async function doRequest(targetUrl, redirectsLeft) {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          req.abort();
        } catch {
          // ignore
        }
        reject(new Error(`image download failed (net): timeout after ${IMAGE_DOWNLOAD_TIMEOUT_MS}ms`));
      }, IMAGE_DOWNLOAD_TIMEOUT_MS);

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
          clearTimeout(timeoutId);
          res.destroy();
          const nextUrl = new URL(location, targetUrl).toString();
          doRequest(nextUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          clearTimeout(timeoutId);
          res.destroy();
          reject(new Error(`image download failed (net): HTTP ${status}`));
          return;
        }

        const contentType = String(res.headers["content-type"] ?? "application/octet-stream");
        const contentLength = res.headers["content-length"] ? Number(res.headers["content-length"]) : null;
        if (contentLength && Number.isFinite(contentLength) && contentLength > maxBytes) {
          clearTimeout(timeoutId);
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
          clearTimeout(timeoutId);
          resolve({ buffer: Buffer.concat(chunks, total), contentType });
        });
        res.on("error", (err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });

      req.on("error", (err) => {
        clearTimeout(timeoutId);
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

async function downloadImage(url, logger, { referer } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);
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
    logger.warn("image download failed", { url, err: String(err) });
    return await downloadImageViaNet(url, { logger, referer });
  } finally {
    clearTimeout(timeout);
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
});

const ImagePrimarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().min(1).max(5000) }),
  z.object({ kind: z.literal("dataUrl"), dataUrl: z.string().min(1).max(5_000_000) }),
]);

const GenerateRecipeSchema = z.object({
  sourceUrl: z.string().min(1).max(5000),
  caption: z.string().max(200_000),
  images: z.array(ImagePrimarySchema).max(40).optional(),
});

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
        command: z.string().optional(),
        args: z.union([z.array(z.string()), z.string()]).optional(),
        httpUrl: z.string().url().optional(),
        toolName: z.string().optional(),
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

  const { ipcMain } = await import("electron");

  ipcMain.handle("config:get", async () => configStore.getPublicConfig());
  ipcMain.handle("config:save", async (_e, patch) => {
    const parsed = ConfigPatchSchema.parse(patch);
    await configStore.applyPatch(parsed);
    return configStore.getPublicConfig();
  });

  ipcMain.handle("logs:get", async () => logger.getEntries());
  ipcMain.handle("logs:openFolder", async () => {
    const folder = logger.getLogsFolderPath();
    if (folder) await shell.openPath(folder);
    return { folder };
  });

  ipcMain.handle("xhs:fetchPost", async (_e, { url }) => {
    const parsed = XhsFetchSchema.parse({ url });
    logger.info("fetch start", { url: parsed.url });
    const post = await xhsClient.getPost(parsed.url);
    logger.info("fetch done", { url: parsed.url, images: post.images.length, captionLen: post.caption.length });
    return post;
  });

  ipcMain.handle("images:previews", async (_e, { images }) => {
    const list = Array.isArray(images) ? images : [];
    const out = [];

    function cacheSet(key, dataUrl) {
      previewCache.set(key, { ts: Date.now(), dataUrl });
      while (previewCache.size > PREVIEW_CACHE_MAX) {
        const oldestKey = previewCache.keys().next().value;
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

  ipcMain.handle("openai:generateRecipe", async (_e, { sourceUrl, caption, images }) => {
    const parsed = GenerateRecipeSchema.parse({ sourceUrl, caption, images: Array.isArray(images) ? images : [] });
    const cfg = await configStore.getResolvedConfig();
    const apiKey = await configStore.getOpenAIApiKey();
    if (!apiKey) throw new Error("Missing OpenAI API key. Set OPENAI_API_KEY in .env.");

    const requested = parsed.images ?? [];
    const imageDataUrls = [];
    const failures = [];
    for (const img of requested) {
      if (img.kind === "dataUrl" && img.dataUrl) {
        imageDataUrls.push(img.dataUrl);
        continue;
      }
      if (img.kind === "url" && img.url) {
        const downloaded = await downloadImage(img.url, logger, { referer: parsed.sourceUrl });
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
    const userPrompt = buildUserPrompt({ sourceUrl: parsed.sourceUrl, caption: parsed.caption });
    const markdown = await openaiClient.generateRecipeMarkdown({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      imageDataUrls,
    });
    const normalized = normalizeMarkdownRecipe(markdown);
    logger.info("openai generate done", { chars: normalized.length });
    return {
      markdown: normalized,
      meta: { images: { requested: requested.length, attached: imageDataUrls.length, failures } },
    };
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
    Promise.allSettled([xhsClient.shutdown?.(), logger.flush?.()]).finally(() => app.quit());
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
