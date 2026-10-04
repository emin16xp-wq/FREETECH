// Preload for the AI-pointer overlay (visible cursor halo while Orbit uses the PC).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pcPointer', {
  onPointer: (cb) => ipcRenderer.on('pc:pointer', (_e, ev) => cb(ev))
});
