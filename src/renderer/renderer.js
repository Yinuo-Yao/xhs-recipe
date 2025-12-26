import { extractFirstHttpsUrl } from "../shared/urlSanitizer.js";

const $ = (id) => document.getElementById(id);

const banners = new Map(); // key -> HTMLElement

const ui = {
  bannerArea: $("bannerArea"),

  urlInput: $("urlInput"),
  urlSanitizeHint: $("urlSanitizeHint"),
  outputLanguageInput: $("outputLanguageInput"),

  fetchBtn: $("fetchBtn"),
  clearBtn: $("clearBtn"),
  settingsBtn: $("settingsBtn"),
  statusLine: $("statusLine"),

  captionBox: $("captionBox"),
  imagesGrid: $("imagesGrid"),

  generateBtn: $("generateBtn"),
  copyBtn: $("copyBtn"),
  exportBtn: $("exportBtn"),
  outputBox: $("outputBox"),

  logsPanel: $("logsPanel"),
  refreshLogsBtn: $("refreshLogsBtn"),
  openLogsFolderBtn: $("openLogsFolderBtn"),
  logsBox: $("logsBox"),

  refreshImagesBtn: $("refreshImagesBtn"),
  resetEditsBtn: $("resetEditsBtn"),

  settingsDialog: $("settingsDialog"),
  modelInput: $("modelInput"),
  mcpTransportInput: $("mcpTransportInput"),
  mcpExePathInput: $("mcpExePathInput"),
  browseMcpExeBtn: $("browseMcpExeBtn"),
  mcpHttpUrlInput: $("mcpHttpUrlInput"),
  mcpCommandInput: $("mcpCommandInput"),
  mcpArgsInput: $("mcpArgsInput"),
  mcpToolInput: $("mcpToolInput"),
  saveSettingsBtn: $("saveSettingsBtn"),

  confirmClearDialog: $("confirmClearDialog"),
  confirmClearBtn: $("confirmClearBtn"),
};

const state = {
  post: null,
  selectedImageId: null,
  deletedImageIds: new Set(),
  imagePreviews: new Map(), // id -> dataUrl
  fetching: false,
  generating: false,
  config: null,
  sessionToken: 0,
  requestSeq: 0,
  currentFetchRequestId: null,
  currentGenerateRequestId: null,
  mcpStatusUnsub: null,
};

function getBridge() {
  if (!window.xhsRecipe) {
    throw new Error("App bridge not available (preload failed). Restart the app and try again.");
  }
  return window.xhsRecipe;
}

function setStatus(text) {
  ui.statusLine.textContent = text;
}

function setBanner(key, { kind = "info", title, message, actions = [] }) {
  if (!ui.bannerArea) return;
  const existing = banners.get(key);
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "banner";
  el.dataset.kind = kind;

  const left = document.createElement("div");
  const h = document.createElement("div");
  h.className = "bannerTitle";
  h.textContent = title || "";
  const p = document.createElement("div");
  p.className = "bannerMessage";
  p.textContent = message || "";
  left.appendChild(h);
  left.appendChild(p);

  const right = document.createElement("div");
  right.className = "bannerActions";
  for (const a of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost small";
    btn.textContent = a.label;
    btn.addEventListener("click", () => {
      if (a.id === "openSettings") ui.settingsBtn.click();
    });
    right.appendChild(btn);
  }

  el.appendChild(left);
  if (actions.length) el.appendChild(right);
  ui.bannerArea.appendChild(el);
  banners.set(key, el);
}

function clearBanner(key) {
  const el = banners.get(key);
  if (el) el.remove();
  banners.delete(key);
}

function detectHallucinationCues(markdown, outputLanguage) {
  const text = String(markdown ?? "");
  const patterns =
    outputLanguage === "en"
      ? [
          /\boptional\b/gi,
          /\bsubstitut(e|ion)s?\b/gi,
          /\brecommend\b/gi,
          /\busually\b/gi,
          /\bgenerally\b/gi,
          /\btips?\b/gi,
        ]
      : [/建议/g, /最好/g, /通常/g, /可选/g, /替换/g, /小贴士/g, /贴士/g];

  const hits = new Set();
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    for (const w of m) hits.add(String(w).toLowerCase());
  }
  return Array.from(hits).slice(0, 8);
}

function updateHallucinationBanner({ markdown }) {
  const lang = state.config?.ui?.outputLanguage ?? ui.outputLanguageInput.value ?? "zh-Hans";
  const hits = detectHallucinationCues(markdown, lang);
  if (hits.length === 0) {
    clearBanner("hallucination");
    return;
  }
  setBanner("hallucination", {
    kind: "warn",
    title: "Validation",
    message: "Output may include inferred content; consider regenerating.",
  });
}

function setBusy({ fetching, generating }) {
  if (typeof fetching === "boolean") state.fetching = fetching;
  if (typeof generating === "boolean") state.generating = generating;

  ui.fetchBtn.disabled = state.fetching || state.generating;
  ui.generateBtn.disabled = state.generating || !state.post;
  ui.copyBtn.disabled = state.generating || !ui.outputBox.value.trim();
  ui.exportBtn.disabled = state.generating || !ui.outputBox.value.trim();
}

function validateUrl(input) {
  const url = String(input ?? "").trim();
  if (!url) throw new Error("Please paste a share URL.");
  if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http(s)://");
  return url;
}

function makeRequestId(prefix) {
  state.requestSeq += 1;
  return `${prefix}_${Date.now()}_${state.requestSeq}`;
}

function isAbortError(err) {
  const msg = String(err?.message ?? err);
  return err?.name === "AbortError" || msg === "Request aborted" || msg.toLowerCase().includes("aborted");
}

let mcpReadyTimer = null;
function updateMcpBanner(status) {
  const st = status?.state;
  if (mcpReadyTimer) {
    clearTimeout(mcpReadyTimer);
    mcpReadyTimer = null;
  }

  if (!st || st === "idle" || st === "disabled") {
    clearBanner("mcp");
    return;
  }

  if (st === "needs_path") {
    setBanner("mcp", {
      kind: "warn",
      title: "MCP",
      message: status?.message || "Set MCP path to enable fetching.",
      actions: [{ id: "openSettings", label: "Open Settings" }],
    });
    return;
  }

  if (st === "starting") {
    setBanner("mcp", { kind: "info", title: "MCP", message: status?.message || "Starting MCP…" });
    return;
  }

  if (st === "ready") {
    setBanner("mcp", { kind: "info", title: "MCP", message: status?.message || "MCP ready." });
    mcpReadyTimer = setTimeout(() => clearBanner("mcp"), 2200);
    return;
  }

  if (st === "error") {
    const msg = status?.detail ? `${status.message} ${status.detail}` : status?.message || "MCP failed to start.";
    setBanner("mcp", {
      kind: "error",
      title: "MCP",
      message: msg,
      actions: [{ id: "openSettings", label: "Open Settings" }],
    });
    return;
  }
}

let urlHintTimer = null;
function showUrlSanitizedHint() {
  if (!ui.urlSanitizeHint) return;
  ui.urlSanitizeHint.hidden = false;
  if (urlHintTimer) clearTimeout(urlHintTimer);
  urlHintTimer = setTimeout(() => {
    ui.urlSanitizeHint.hidden = true;
    urlHintTimer = null;
  }, 2200);
}

function sanitizeUrlInputIfNeeded() {
  const raw = String(ui.urlInput.value ?? "");
  const extracted = extractFirstHttpsUrl(raw);
  if (!extracted) return;
  if (extracted === raw) return;
  ui.urlInput.value = extracted;
  showUrlSanitizedHint();
}

function renderImages() {
  ui.imagesGrid.innerHTML = "";
  const images = (state.post?.images ?? []).filter((img) => !state.deletedImageIds.has(img.id));
  if (images.length === 0) {
    ui.imagesGrid.innerHTML = `<div class="empty">No images</div>`;
    return;
  }

  for (const img of images) {
    const div = document.createElement("button");
    div.className = "thumb";
    div.type = "button";
    div.title = img.id;
    if (img.id === state.selectedImageId) div.dataset.selected = "true";

    const el = document.createElement("img");
    el.src = state.imagePreviews.get(img.id) ?? img.previewUrl;
    el.referrerPolicy = "no-referrer";
    el.alt = img.id;
    div.appendChild(el);

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.title = "Remove image";
    remove.textContent = "×";
    remove.addEventListener("click", (ev) => {
      ev.stopPropagation();
      state.deletedImageIds.add(img.id);
      if (state.selectedImageId === img.id) {
        const remaining = (state.post?.images ?? []).filter((x) => !state.deletedImageIds.has(x.id));
        state.selectedImageId = remaining[0]?.id ?? null;
      }
      renderImages();
    });
    div.appendChild(remove);

    div.addEventListener("click", () => {
      state.selectedImageId = img.id;
      renderImages();
    });

    ui.imagesGrid.appendChild(div);
  }
}

async function downloadPreviewsForCurrentPost() {
  if (!state.post) return;
  setStatus("Downloading images...");
  try {
    const res = await getBridge().getImagePreviews(state.post.images ?? []);
    state.imagePreviews = new Map((res?.previews ?? []).map((p) => [p.id, p.dataUrl]));
    renderImages();
    setStatus("Images downloaded");
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  }
}

function resetEdits() {
  if (!state.post) return;
  state.deletedImageIds = new Set();
  state.selectedImageId = state.post.images?.[0]?.id ?? null;
  ui.captionBox.value = state.post.caption ?? "";
  void downloadPreviewsForCurrentPost();
  renderImages();
  setStatus("Reset");
}

ui.refreshImagesBtn.addEventListener("click", downloadPreviewsForCurrentPost);
ui.resetEditsBtn.addEventListener("click", resetEdits);

function getSelectedImagePayloads() {
  if (!state.post) return [];
  const images = (state.post.images ?? []).filter((img) => !state.deletedImageIds.has(img.id));
  if (images.length === 0) return [];
  const selected = images.find((i) => i.id === state.selectedImageId) ?? images[0];
  const ordered = [selected, ...images.filter((i) => i.id !== selected.id)];
  return ordered.map((i) => i.source).filter(Boolean);
}

function suggestedFileName(markdown) {
  const firstLine = String(markdown ?? "").split("\n")[0] ?? "";
  const title = firstLine.replace(/^#+\s*/, "").trim();
  return title || "recipe";
}

async function refreshConfig() {
  state.config = await getBridge().getConfig();
  ui.modelInput.value = state.config?.openai?.model ?? "gpt-4o-mini";
  ui.mcpTransportInput.value = state.config?.mcp?.transport ?? "http";
  ui.mcpHttpUrlInput.value = state.config?.mcp?.httpUrl ?? "http://localhost:18060/mcp";
  ui.mcpCommandInput.value = state.config?.mcp?.command ?? "";
  ui.mcpArgsInput.value = Array.isArray(state.config?.mcp?.args) ? state.config.mcp.args.join(" ") : "";
  ui.mcpToolInput.value = state.config?.mcp?.toolName ?? "";
  ui.mcpExePathInput.value = state.config?.mcp?.exePath ?? "";
  ui.outputLanguageInput.value = state.config?.ui?.outputLanguage ?? "zh-Hans";

  if (state.config?.openai?.hasApiKey) setStatus("OpenAI key: OK");
  else setStatus("OpenAI key missing: set OPENAI_API_KEY in .env");
}

function updateSettingsVisibility() {
  const transport = ui.mcpTransportInput.value;
  const isHttp = transport === "http";
  ui.mcpHttpUrlInput.closest(".field").style.display = isHttp ? "" : "none";
  ui.mcpExePathInput.closest(".field").style.display = isHttp ? "" : "none";
  ui.mcpCommandInput.closest(".field").style.display = isHttp ? "none" : "";
  ui.mcpArgsInput.closest(".field").style.display = isHttp ? "none" : "";
}

ui.mcpTransportInput.addEventListener("change", updateSettingsVisibility);

async function refreshLogs() {
  const logs = await getBridge().getLogs();
  ui.logsBox.textContent = logs
    .map((e) => {
      const data = e.data ? ` ${JSON.stringify(e.data)}` : "";
      return `${e.ts} [${e.level}] ${e.message}${data}`;
    })
    .join("\n");
}

ui.settingsBtn.addEventListener("click", async () => {
  try {
    await refreshConfig();
    updateSettingsVisibility();
    ui.settingsDialog.showModal();
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  }
});

ui.browseMcpExeBtn.addEventListener("click", async () => {
  try {
    if (!getBridge().pickMcpExecutable) throw new Error("File picker not available in this build.");
    const res = await getBridge().pickMcpExecutable();
    if (res?.canceled) return;
    if (res?.filePath) ui.mcpExePathInput.value = res.filePath;
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  }
});

ui.saveSettingsBtn.addEventListener("click", async (ev) => {
  ev.preventDefault();
  const transport = ui.mcpTransportInput.value;
  const httpUrl = ui.mcpHttpUrlInput.value.trim() || "http://localhost:18060/mcp";
  const patch = {
    openai: {
      model: ui.modelInput.value.trim() || "gpt-4o-mini",
    },
    mcp: {
      transport,
      httpUrl,
      exePath: ui.mcpExePathInput.value.trim(),
      command: ui.mcpCommandInput.value.trim(),
      args: ui.mcpArgsInput.value,
      toolName: ui.mcpToolInput.value.trim(),
    },
  };
  try {
    await getBridge().saveConfig(patch);
    ui.settingsDialog.close();
    await refreshConfig();
    if (getBridge().getMcpStatus) updateMcpBanner(await getBridge().getMcpStatus());
    setStatus("Settings saved");
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  }
});

ui.outputLanguageInput.addEventListener("change", async () => {
  try {
    await getBridge().saveConfig({ ui: { outputLanguage: ui.outputLanguageInput.value } });
    await refreshConfig();
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  }
});

ui.fetchBtn.addEventListener("click", async () => {
  const token = state.sessionToken;
  const requestId = makeRequestId("fetch");
  state.currentFetchRequestId = requestId;
  try {
    sanitizeUrlInputIfNeeded();
    const url = validateUrl(ui.urlInput.value);
    setBusy({ fetching: true });
    setStatus("Fetching...");
    const post = await getBridge().fetchPost({ url, requestId });
    if (state.sessionToken !== token || state.currentFetchRequestId !== requestId) return;
    state.post = post;
    state.selectedImageId = post.images?.[0]?.id ?? null;
    state.deletedImageIds = new Set();
    ui.captionBox.value = post.caption ?? "";

    await downloadPreviewsForCurrentPost();
    renderImages();
    setStatus(`Fetched (${post.images.length} image(s))`);

    const recent = [url, ...(state.config?.recentUrls ?? [])];
    const deduped = [];
    const seen = new Set();
    for (const item of recent) {
      if (seen.has(item)) continue;
      seen.add(item);
      deduped.push(item);
    }
    await getBridge().saveConfig({ recentUrls: deduped });
    await refreshConfig();
  } catch (err) {
    if (state.sessionToken !== token) return;
    if (isAbortError(err)) return;
    setStatus(`Error: ${err?.message ?? err}`);
  } finally {
    if (state.sessionToken !== token) return;
    if (state.currentFetchRequestId === requestId) state.currentFetchRequestId = null;
    setBusy({ fetching: false });
  }
});

ui.urlInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") ui.fetchBtn.click();
});

ui.urlInput.addEventListener("input", () => {
  sanitizeUrlInputIfNeeded();
});

ui.generateBtn.addEventListener("click", async () => {
  const token = state.sessionToken;
  const requestId = makeRequestId("generate");
  state.currentGenerateRequestId = requestId;
  try {
    if (!state.post) throw new Error("Fetch a post first.");
    clearBanner("hallucination");
    setBusy({ generating: true });
    setStatus("Generating...");
    const res = await getBridge().generateRecipe({
      sourceUrl: state.post.sourceUrl,
      caption: ui.captionBox.value ?? "",
      images: getSelectedImagePayloads(),
      requestId,
    });
    if (state.sessionToken !== token || state.currentGenerateRequestId !== requestId) return;
    ui.outputBox.value = res.markdown ?? "";
    updateHallucinationBanner({ markdown: ui.outputBox.value });
    const meta = res?.meta?.images;
    if (meta?.attached > 0) setStatus(`Completed (${meta.attached}/${meta.requested} image(s) sent)`);
    else setStatus("Completed (no image sent)");
  } catch (err) {
    if (state.sessionToken !== token) return;
    if (isAbortError(err)) return;
    setStatus(`Error: ${err?.message ?? err}`);
  } finally {
    if (state.sessionToken !== token) return;
    if (state.currentGenerateRequestId === requestId) state.currentGenerateRequestId = null;
    setBusy({ generating: false });
  }
});

ui.outputBox.addEventListener("input", () => {
  setBusy({});
});

ui.copyBtn.addEventListener("click", async () => {
  try {
    await getBridge().copyToClipboard(ui.outputBox.value);
    setStatus("Copied to clipboard");
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  }
});

ui.exportBtn.addEventListener("click", async () => {
  try {
    const markdown = ui.outputBox.value;
    const suggestedName = suggestedFileName(markdown);
    const res = await getBridge().exportMarkdown({ markdown, suggestedName });
    if (res.canceled) setStatus("Export canceled");
    else setStatus(`Exported: ${res.filePath}`);
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  }
});

ui.refreshLogsBtn.addEventListener("click", refreshLogs);
ui.openLogsFolderBtn.addEventListener("click", async () => {
  try {
    await getBridge().openLogsFolder();
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  }
});

ui.logsPanel.addEventListener("toggle", () => {
  if (ui.logsPanel.open) void refreshLogs();
});

ui.clearBtn.addEventListener("click", async () => {
  if (state.fetching || state.generating) {
    ui.confirmClearDialog.showModal();
    const res = await new Promise((resolve) => {
      const onClose = () => resolve(ui.confirmClearDialog.returnValue);
      ui.confirmClearDialog.addEventListener("close", onClose, { once: true });
    });
    if (res !== "clear") return;
  }

  state.sessionToken += 1;
  try {
    await getBridge().abortAllRequests?.();
    await getBridge().clearSession?.();
  } catch {
    // ignore
  }

  state.post = null;
  state.selectedImageId = null;
  state.deletedImageIds = new Set();
  state.imagePreviews = new Map();
  state.currentFetchRequestId = null;
  state.currentGenerateRequestId = null;
  ui.urlInput.value = "";
  ui.captionBox.value = "";
  ui.outputBox.value = "";
  ui.logsBox.textContent = "";
  ui.logsPanel.open = false;
  ui.imagesGrid.innerHTML = `<div class="empty">No images</div>`;
  if (ui.urlSanitizeHint) ui.urlSanitizeHint.hidden = true;
  clearBanner("hallucination");
  setBusy({ fetching: false, generating: false });
  setStatus("Idle");
});

// boot
(async () => {
  try {
    await refreshConfig();
    setBusy({ fetching: false, generating: false });
    if (getBridge().getMcpStatus) updateMcpBanner(await getBridge().getMcpStatus());
    if (getBridge().onMcpStatus) state.mcpStatusUnsub = getBridge().onMcpStatus(updateMcpBanner);

    const recent = state.config?.recentUrls ?? [];
    if (recent.length > 0) ui.urlInput.value = recent[0];
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
    setBusy({ fetching: false, generating: false });
  }
})();

window.addEventListener("beforeunload", () => {
  try {
    state.mcpStatusUnsub?.();
  } catch {
    // ignore
  }
  state.mcpStatusUnsub = null;
});
