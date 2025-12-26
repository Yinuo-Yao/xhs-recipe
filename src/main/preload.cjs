const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xhsRecipe", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),

  fetchPost: (payload) => {
    if (typeof payload === "string") return ipcRenderer.invoke("xhs:fetchPost", { url: payload });
    return ipcRenderer.invoke("xhs:fetchPost", payload);
  },
  getImagePreviews: (images) => ipcRenderer.invoke("images:previews", { images }),
  generateRecipe: (payload) => ipcRenderer.invoke("openai:generateRecipe", payload),

  abortRequest: (requestId) => ipcRenderer.invoke("request:abort", { requestId }),
  abortAllRequests: () => ipcRenderer.invoke("request:abortAll"),
  clearSession: () => ipcRenderer.invoke("session:clear"),

  pickMcpExecutable: () => ipcRenderer.invoke("dialog:pickMcpExecutable"),
  getMcpStatus: () => ipcRenderer.invoke("mcp:getStatus"),
  onMcpStatus: (handler) => {
    const cb = (_e, status) => handler(status);
    ipcRenderer.on("mcp:status", cb);
    return () => ipcRenderer.removeListener("mcp:status", cb);
  },

  copyToClipboard: (text) => ipcRenderer.invoke("output:copy", { text }),
  exportMarkdown: ({ markdown, suggestedName }) => ipcRenderer.invoke("output:exportMarkdown", { markdown, suggestedName }),

  getLogs: () => ipcRenderer.invoke("logs:get"),
  openLogsFolder: () => ipcRenderer.invoke("logs:openFolder"),
});
