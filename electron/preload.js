const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('postie', {
  getPort: () => ipcRenderer.invoke('postie:port'),
  openFile: (opts) => ipcRenderer.invoke('postie:open-file', opts),
  saveFile: (opts) => ipcRenderer.invoke('postie:save-file', opts),
  pickFilePath: (opts) => ipcRenderer.invoke('postie:pick-file-path', opts),
});
