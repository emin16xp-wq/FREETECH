// Secure bridge between the renderer UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const SUBSCRIBE_CHANNELS = ['agent:event', 'mcp:changed', 'hotkey:changed', 'overlay:changed', 'config:changed', 'chats:changed'];

contextBridge.exposeInMainWorld('orbit', {
  // config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // providers / models
  listModels: (provider) => ipcRenderer.invoke('models:list', provider),
  testKey: (provider) => ipcRenderer.invoke('keys:test', provider),

  // chat
  sendChat: (messages, opts) => ipcRenderer.invoke('chat:send', { messages, fromCall: !!(opts && opts.fromCall), chatId: opts && opts.chatId }),
  stopChat: () => ipcRenderer.send('chat:stop'),
  getHistory: () => ipcRenderer.invoke('chat:history'),

  // multi-chat
  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    open: (id) => ipcRenderer.invoke('chats:open', id),
    create: () => ipcRenderer.invoke('chats:new'),
    remove: (id) => ipcRenderer.invoke('chats:delete', id)
  },

  // memory
  memories: {
    list: () => ipcRenderer.invoke('memories:list'),
    add: (text) => ipcRenderer.invoke('memories:add', text),
    remove: (id) => ipcRenderer.invoke('memories:remove', id)
  },
  clearHistory: () => ipcRenderer.invoke('chat:clear'),

  // vision / attachments
  captureScreen: () => ipcRenderer.invoke('screen:capture'),

  // voice
  transcribe: (audioBytes, lang) => ipcRenderer.invoke('voice:transcribe', { audio: audioBytes, lang: lang || undefined }),
  ttsSpeak: (opts) => ipcRenderer.invoke('tts:speak', opts),
  ttsStop: () => ipcRenderer.send('tts:stop'),
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),

  // overlay (floating button)
  showOverlay: (show) => ipcRenderer.invoke('overlay:show', show),
  getOverlayState: () => ipcRenderer.invoke('overlay:state'),
  openChat: () => ipcRenderer.send('overlay:open-chat'),

  // connectors (MCP)
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (server) => ipcRenderer.invoke('mcp:add', server),
    update: (id, patch) => ipcRenderer.invoke('mcp:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('mcp:remove', id),
    toggle: (id, enabled) => ipcRenderer.invoke('mcp:toggle', { id, enabled }),
    templates: () => ipcRenderer.invoke('mcp:templates'),
    importKnown: () => ipcRenderer.invoke('mcp:import-known'),
    pickFile: () => ipcRenderer.invoke('mcp:pick-file'),
    importServers: (servers) => ipcRenderer.invoke('mcp:import-servers', { servers })
  },

  // PC-control approvals
  respondApproval: (id, allowed) => ipcRenderer.send('approval:respond', { id, allowed }),
  pcTest: () => ipcRenderer.invoke('pc:test'),
  openChatCall: () => ipcRenderer.send('app:open-chat-call'),

  // misc app
  openMain: () => ipcRenderer.send('app:open-main'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  quit: () => ipcRenderer.send('app:quit'),
  minimize: () => ipcRenderer.send('app:minimize'),

  // event subscriptions
  on: (channel, cb) => {
    if (!SUBSCRIBE_CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
