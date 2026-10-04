// Preload for the floating overlay button.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbitOverlay', {
  dragStart: () => ipcRenderer.send('overlay:drag-start'),
  dragDelta: (dx, dy) => ipcRenderer.send('overlay:drag-delta', { dx, dy }),
  dragEnd: () => ipcRenderer.send('overlay:drag-end'),
  menu: () => ipcRenderer.send('overlay:menu'),
  onAnim: (cb) => ipcRenderer.on('overlay:anim', (_e, mode) => cb(mode))
});
