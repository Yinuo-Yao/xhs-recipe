const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xhsRecipe", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),

  fetchPost: (url) => ipcRenderer.invoke("xhs:fetchPost", { url }),
  getImagePreviews: (images) => ipcRenderer.invoke("images:previews", { images }),
  generateRecipe: (payload) => ipcRenderer.invoke("openai:generateRecipe", payload),

  copyToClipboard: (text) => ipcRenderer.invoke("output:copy", { text }),
  exportMarkdown: ({ markdown, suggestedName }) =>
    ipcRenderer.invoke("output:exportMarkdown", { markdown, suggestedName }),

  getLogs: () => ipcRenderer.invoke("logs:get"),
  openLogsFolder: () => ipcRenderer.invoke("logs:openFolder"),
});
