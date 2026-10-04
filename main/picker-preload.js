// Preload for the model-picker window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerApi', {
  init: () => ipcRenderer.invoke('picker:init'),
  listModels: (provider) => ipcRenderer.invoke('models:list', provider),
  setModel: (provider, modelId) => ipcRenderer.invoke('picker:set-model', { provider, modelId }),
  close: () => ipcRenderer.send('picker:close')
});
