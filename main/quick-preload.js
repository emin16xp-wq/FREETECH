// Preload for the quick-capture popup (select text anywhere → hotkey → instant AI actions).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quickApi', {
  init: () => ipcRenderer.invoke('quick:init'),
  ask: (instruction) => ipcRenderer.invoke('quick:ask', { instruction }),
  stop: () => ipcRenderer.send('quick:stop'),
  copy: (text) => ipcRenderer.invoke('quick:copy', { text }),
  recapture: () => ipcRenderer.invoke('quick:recapture'),
  close: () => ipcRenderer.send('quick:close'),
  onEvent: (cb) => ipcRenderer.on('quick:event', (_e, ev) => cb(ev))
});
