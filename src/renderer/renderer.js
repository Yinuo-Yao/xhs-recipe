const $ = (id) => document.getElementById(id);

const ui = {
  urlInput: $("urlInput"),
  fetchBtn: $("fetchBtn"),
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
  mcpHttpUrlInput: $("mcpHttpUrlInput"),
  mcpCommandInput: $("mcpCommandInput"),
  mcpArgsInput: $("mcpArgsInput"),
  mcpToolInput: $("mcpToolInput"),
  saveSettingsBtn: $("saveSettingsBtn"),
};

const state = {
  post: null,
  selectedImageId: null,
  deletedImageIds: new Set(),
  imagePreviews: new Map(), // id -> dataUrl
  fetching: false,
  generating: false,
  config: null,
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
  ui.mcpArgsInput.value = (state.config?.mcp?.args ?? []).join(" ");
  ui.mcpToolInput.value = state.config?.mcp?.toolName ?? "";

  const hasKey = Boolean(state.config?.openai?.hasApiKey);
  if (!hasKey) setStatus("Tip: set OPENAI_API_KEY in .env");
}

function updateSettingsVisibility() {
  const transport = ui.mcpTransportInput.value;
  const isHttp = transport === "http";
  ui.mcpHttpUrlInput.closest(".field").style.display = isHttp ? "" : "none";
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

ui.saveSettingsBtn.addEventListener("click", async (ev) => {
  ev.preventDefault();
  const transport = ui.mcpTransportInput.value;
  const httpUrl =
    transport === "http"
      ? (ui.mcpHttpUrlInput.value.trim() || "http://localhost:18060/mcp")
      : (ui.mcpHttpUrlInput.value.trim() || "http://localhost:18060/mcp");
  const patch = {
    openai: {
      model: ui.modelInput.value.trim() || "gpt-4o-mini",
    },
    mcp: {
      transport,
      httpUrl,
      command: ui.mcpCommandInput.value.trim(),
      args: ui.mcpArgsInput.value,
      toolName: ui.mcpToolInput.value.trim(),
    },
  };
  try {
    await getBridge().saveConfig(patch);
    ui.settingsDialog.close();
    setStatus("Settings saved");
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  }
});

ui.fetchBtn.addEventListener("click", async () => {
  try {
    const url = validateUrl(ui.urlInput.value);
    setBusy({ fetching: true });
    setStatus("Fetching...");
    const post = await getBridge().fetchPost(url);
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
    setStatus(`Error: ${err?.message ?? err}`);
  } finally {
    setBusy({ fetching: false });
  }
});

ui.urlInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") ui.fetchBtn.click();
});

ui.generateBtn.addEventListener("click", async () => {
  try {
    if (!state.post) throw new Error("Fetch a post first.");
    setBusy({ generating: true });
    setStatus("Generating...");
    const res = await getBridge().generateRecipe({
      sourceUrl: state.post.sourceUrl,
      caption: ui.captionBox.value ?? "",
      images: getSelectedImagePayloads(),
    });
    ui.outputBox.value = res.markdown ?? "";
    const meta = res?.meta?.images;
    if (meta?.attached > 0) setStatus(`Completed (${meta.attached}/${meta.requested} image(s) sent)`);
    else setStatus("Completed (no image sent — delete fewer or check image URL access)");
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
  } finally {
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

// boot
(async () => {
  try {
    await refreshConfig();
    setBusy({ fetching: false, generating: false });

    const recent = state.config?.recentUrls ?? [];
    if (recent.length > 0) ui.urlInput.value = recent[0];
  } catch (err) {
    setStatus(`Error: ${err?.message ?? err}`);
    setBusy({ fetching: false, generating: false });
  }
})();
