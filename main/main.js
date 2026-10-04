// Orbit AI — main process.
// Windows: main (settings/dashboard), overlay (floating button), chat (panel).
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, screen, dialog, shell, nativeImage, desktopCapturer, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { PROVIDERS, listModels, testKeyReal, transcribeGroqAudio, speakGroqTts } = require('./providers');
const { TTS, isArabicText } = require('./tts');
const { PcControl } = require('./pccontrol');
const { Memory } = require('./memory');
const { McpManager, TEMPLATES, knownConfigPaths, parseMcpConfigFile } = require('./mcp');
const { runTurn, DEFAULT_SYSTEM_PROMPT } = require('./agent');

const OVERLAY_SIZE = 60;
const CHAT_W = 440;
const CHAT_H = 640;

// Diagnostic flag: `npm start -- --disable-gpu`
// Helps on machines with stubborn GPU drivers (black/hidden windows).
if (process.argv.includes('--disable-gpu')) {
  app.disableHardwareAcceleration();
}

let store, mcp, tray;
let mainWindow = null;
let overlayWin = null;
let chatWin = null;
let chatAbort = null;
const tts = new TTS();
let pc; // PcControl, created in init after store
let mem; // Memory
let pickerWin = null;
let pointerWin = null;
let quickWin = null;
let quickText = '';
let quickAbort = null;
let drag = null; // { moved }
let chatAutoHiddenAt = 0;
let quitting = false;

const DEFAULTS = {
  keys: { groq: '', openrouter: '', nvidia: '', local: '' },
  provider: 'groq',
  models: { groq: 'llama-3.3-70b-versatile', openrouter: 'openai/gpt-4o-mini', nvidia: 'meta/llama-3.3-70b-instruct', local: '' },
  localBaseUrl: 'http://localhost:8080/v1',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.7,
  overlayActive: false,
  overlayPos: { x: null, y: null },
  hotkey: 'Alt+Space',
  launchOnStartup: false,
  autoHideChat: true,
  voiceSettings: { speakReplies: false, voice: '', rate: 0, sttAutoSend: true, callLang: 'auto', micPickup: 'near' },
  pcControl: { enabled: false, mode: 'confirm' },
  memories: [],
  chats: [],
  activeChatId: null,
  mcpServers: [],
  showSkills: true,
  skills: [
    { id: 'summarize', name: 'Summarize', prompt: 'Summarize the following in clear bullet points:\n\n' },
    { id: 'explain', name: 'Explain simply', prompt: 'Explain this in simple words, like I am 12:\n\n' },
    { id: 'grammar', name: 'Fix grammar', prompt: 'Fix the grammar and clarity. Reply only with the corrected text:\n\n' },
    { id: 'translate', name: 'Translate', prompt: 'Translate the following to English. Reply only with the translation:\n\n' }
  ],
  chat: []
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.whenReady().then(() => {
    try {
      init();
    } catch (e) {
      console.error('[Orbit] startup failed:', e);
      dialog.showErrorBox('Orbit AI failed to start', String((e && e.stack) || e.message || e));
      app.quit();
    }
  });
}

/* ---------------------------------- init ---------------------------------- */

function init() {
  const startHidden = process.argv.includes('--hidden') || process.argv.includes('-hidden');
  store = new Store(path.join(app.getPath('userData'), 'config.json'), DEFAULTS);
  console.log('[Orbit] config loaded from', app.getPath('userData'));
  mcp = new McpManager(store);
  mcp.on('changed', () => broadcast('mcp:changed', mcp.listSummaries()));
  pc = new PcControl(store, () => chatWin, (ev) => showPcPointer(ev));
  mem = new Memory(store);

  // One-time migration: legacy single chat → chats list
  if (!store.get('chats', []).length) {
    const legacy = store.get('chat', []);
    if (legacy.length) {
      const id = 'c_' + Date.now().toString(36);
      const first = legacy.find((m) => m.role === 'user');
      const title = (Array.isArray(first && first.content)
        ? ((first.content.find((p) => p.type === 'text') || {}).text || '')
        : (first && first.content) || 'Previous chat').slice(0, 42);
      store.set('chats', [{ id, title, created: Date.now(), updated: Date.now(), messages: legacy }]);
      store.set('activeChatId', id);
    }
  }

  // Allow microphone access for voice input (chat window).
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media');
    });
  } catch {}
  createMainWindow(startHidden);
  createTray();
  console.log('[Orbit] tray created');
  // Warm the TTS voice cache early (both engines) so Arabic auto-selection
  // picks the right engine on the very first spoken word.
  tts.listVoices().catch(() => {});
  registerHotkey();

  if (store.get('overlayActive')) createOverlay();

  // Reconnect enabled MCP servers in the background.
  for (const s of store.get('mcpServers', [])) {
    if (s.enabled) mcp.connect(s.id).catch(() => {});
  }

  app.on('window-all-closed', () => {
    // Keep running in the tray (the floating button lives on).
    if (quitting) app.quit();
  });
  app.on('before-quit', async () => {
    quitting = true;
    globalShortcut.unregisterAll();
    try {
      await mcp.disconnectAll();
    } catch {}
  });
}

/* --------------------------------- windows --------------------------------- */

function winOpts() {
  return {
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    },
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    show: false
  };
}

function createMainWindow(show = true) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (show) showMainWindow();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    ...winOpts(),
    width: 960,
    height: 680,
    minWidth: 820,
    minHeight: 560,
    title: 'Orbit AI',
    frame: false,
    titleBarStyle: 'hidden',
    center: true,
    // Show immediately — no hidden/ready-to-show dance. This is the
    // bulletproof path: the window exists and is visible from the start.
    show: true,
    icon: path.join(__dirname, '..', 'icons', 'icon.png')
  });
  // Stay on top for the first seconds so it can't get lost behind other apps.
  mainWindow.setAlwaysOnTop(true);
  setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    } catch {}
  }, 5000);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'main.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Orbit] UI loaded');
    if (show && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[Orbit] UI failed to load:', code, desc, url);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(true);
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  const { workArea } = screen.getPrimaryDisplay();
  const saved = store.get('overlayPos', {});
  const x = Number.isFinite(saved.x) ? saved.x : workArea.x + workArea.width - OVERLAY_SIZE - 24;
  const y = Number.isFinite(saved.y) ? saved.y : workArea.y + workArea.height - OVERLAY_SIZE - 90;

  overlayWin = new BrowserWindow({
    x,
    y,
    width: OVERLAY_SIZE,
    height: OVERLAY_SIZE,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    },
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlayWin.webContents.on('did-finish-load', () => {
    if (overlayWin && !overlayWin.isDestroyed() && !overlayWin.isVisible()) overlayWin.show();
  });
  overlayWin.once('ready-to-show', () => overlayWin.show());
  // Fallback if the ready event never fires on this machine.
  setTimeout(() => {
    if (overlayWin && !overlayWin.isDestroyed() && !overlayWin.isVisible()) overlayWin.show();
  }, 3000);

  overlayWin.on('closed', () => {
    overlayWin = null;
  });
  return overlayWin;
}

function showOverlay(show) {
  if (show) {
    createOverlay();
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.show();
      // play the appear animation (the renderer also plays it on first load)
      try {
        overlayWin.webContents.send('overlay:anim', 'in');
      } catch {}
    }
    store.set('overlayActive', true);
    broadcast('overlay:changed', { active: true });
  } else {
    const finishHide = () => {
      if (chatWin && !chatWin.isDestroyed()) chatWin.hide();
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
      store.set('overlayActive', false);
      broadcast('overlay:changed', { active: false });
    };
    if (overlayWin && !overlayWin.isDestroyed()) {
      // let the disappear animation play, then hide the window
      try {
        overlayWin.webContents.send('overlay:anim', 'out');
      } catch {}
      setTimeout(finishHide, 280);
    } else {
      finishHide();
    }
  }
}

/* ---------- visible AI cursor (halo overlay while Orbit uses the PC) ---------- */
function ensurePointerWindow() {
  if (pointerWin && !pointerWin.isDestroyed()) return pointerWin;
  pointerWin = new BrowserWindow({
    width: 500,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, 'pointer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    },
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false
  });
  pointerWin.setAlwaysOnTop(true, 'screen-saver');
  pointerWin.setIgnoreMouseEvents(true); // never blocks the real mouse
  pointerWin.loadFile(path.join(__dirname, '..', 'renderer', 'pointer.html'));
  pointerWin.on('closed', () => {
    pointerWin = null;
  });
  return pointerWin;
}

// Physical-pixel PC coords → DIP coords relative to the overlay window.
function showPcPointer(ev) {
  try {
    const w = ensurePointerWindow();
    if (!w || w.isDestroyed()) return;
    let display = null;
    const px = Math.round(ev.x || 0);
    const py = Math.round(ev.y || 0);
    // physical px → DIP: guess with the primary scale, then refine per display
    let scale = screen.getPrimaryDisplay().scaleFactor || 1;
    try {
      display = screen.getDisplayNearestPoint({ x: px / scale, y: py / scale });
      if (display && display.scaleFactor && display.scaleFactor !== scale) {
        scale = display.scaleFactor;
        display = screen.getDisplayNearestPoint({ x: px / scale, y: py / scale });
      }
    } catch {}
    if (!display) display = screen.getPrimaryDisplay();
    scale = display.scaleFactor || scale;
    const wa = display.workArea;
    const b = w.getBounds();
    if (b.x !== wa.x || b.y !== wa.y || b.width !== wa.width || b.height !== wa.height) {
      w.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    }
    w.showInactive();
    const conv = (px) => (px == null ? null : px / scale - (wa.x));
    const convY = (px) => (px == null ? null : px / scale - (wa.y));
    w.webContents.send('pc:pointer', {
      kind: ev.kind,
      x: conv(ev.x),
      y: convY(ev.y),
      fromX: conv(ev.fromX),
      fromY: convY(ev.fromY),
      toX: conv(ev.toX),
      toY: convY(ev.toY),
      button: ev.button,
      double: ev.double,
      combo: ev.combo,
      text: ev.text
    });
  } catch {}
}

/* ----------------------- quick capture (select text → hotkey) ----------------------- */
const AR_RE = /[\u0600-\u06FF]/;

function psSendKeys(combo) {
  const script = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('" + combo + "');";
  const child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 900);
    child.on('close', () => { clearTimeout(t); resolve(); });
    child.on('error', () => { clearTimeout(t); resolve(); });
  });
}

async function captureSelectedText() {
  if (process.platform !== 'win32') return '';
  const prev = clipboard.readText();
  await psSendKeys('^c'); // copy the user's current selection
  await new Promise((r) => setTimeout(r, 380));
  const text = clipboard.readText() || '';
  if (text !== prev) {
    clipboard.writeText(prev); // restore — the user's clipboard stays untouched
  }
  return text === prev ? '' : text; // unchanged clipboard = nothing was selected
}

function positionQuickWindow() {
  try {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    const wa = d.workArea;
    const b = quickWin.getBounds();
    let x = p.x + 14;
    let y = p.y - 60;
    if (x + b.width > wa.x + wa.width) x = p.x - b.width - 14;
    if (y + b.height > wa.y + wa.height) y = wa.y + wa.height - b.height - 10;
    if (y < wa.y) y = wa.y + 10;
    quickWin.setPosition(Math.max(wa.x, Math.round(x)), Math.max(wa.y, Math.round(y)));
  } catch {}
}

async function toggleQuickCapture() {
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible()) {
    quickWin.hide();
    return;
  }
  quickText = await captureSelectedText();
  if (!quickWin || quickWin.isDestroyed()) {
    quickWin = new BrowserWindow({
      width: 460,
      height: 400,
      webPreferences: {
        preload: path.join(__dirname, 'quick-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      },
      backgroundColor: '#0b0e14',
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false
    });
    quickWin.setAlwaysOnTop(true, 'screen-saver');
    quickWin.loadFile(path.join(__dirname, '..', 'renderer', 'quick.html'));
    quickWin.on('blur', () => {
      if (quickWin && !quickWin.isDestroyed()) quickWin.hide();
    });
    quickWin.on('closed', () => {
      quickWin = null;
    });
  }
  positionQuickWindow();
  quickWin.show();
  quickWin.focus();
}

function switchProvider(id) {
  if (!PROVIDERS[id]) return;
  const models = store.get('models', {});
  store.set('provider', id);
  if (!models[id]) {
    models[id] = id === 'local' ? '' : (DEFAULTS.models[id] || '');
    store.set('models', models);
  }
  broadcast('config:changed', store.data);
}

function openModelPicker() {
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.show();
    pickerWin.focus();
    return;
  }
  pickerWin = new BrowserWindow({
    width: 430,
    height: 540,
    webPreferences: {
      preload: path.join(__dirname, 'picker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    },
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true
  });
  pickerWin.setAlwaysOnTop(true, 'screen-saver');
  // position near the orb if it's active, else center of the work area
  try {
    if (overlayWin && !overlayWin.isDestroyed()) {
      const b = overlayWin.getBounds();
      const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
      const wa = display.workArea;
      let x = b.x + b.width + 12;
      if (x + 430 > wa.x + wa.width) x = b.x - 430 - 12;
      const y = Math.max(wa.y + 8, Math.min(b.y - 200, wa.y + wa.height - 540 - 8));
      pickerWin.setPosition(Math.max(wa.x + 8, x), y);
    } else {
      pickerWin.center();
    }
  } catch {
    pickerWin.center();
  }
  pickerWin.loadFile(path.join(__dirname, '..', 'renderer', 'picker.html'));
  pickerWin.on('closed', () => {
    pickerWin = null;
  });
}

function createChat() {
  if (chatWin && !chatWin.isDestroyed()) return chatWin;
  chatWin = new BrowserWindow({
    width: CHAT_W,
    height: CHAT_H,
    ...winOpts(),
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: true,
    minWidth: 340,
    minHeight: 380,
    title: 'Orbit Chat'
  });
  chatWin.loadFile(path.join(__dirname, '..', 'renderer', 'chat.html'));
  chatWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      chatWin.hide();
    }
  });
  chatWin.on('blur', () => {
    if (store.get('autoHideChat', true) && chatWin.isVisible()) {
      chatWin.hide();
      chatAutoHiddenAt = Date.now();
    }
  });
  return chatWin;
}

function positionChatNearOverlay() {
  if (!chatWin || !overlayWin) return;
  const b = overlayWin.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const wa = display.workArea;
  let x = b.x + b.width + 14;
  if (x + CHAT_W > wa.x + wa.width) x = b.x - CHAT_W - 14;
  if (x < wa.x) x = Math.min(wa.x + wa.width - CHAT_W, b.x + b.width + 14);
  let y = Math.round(b.y - 40);
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - CHAT_H - 8));
  chatWin.setPosition(Math.round(x), Math.round(y));
}

function toggleChat() {
  // Robust open/toggle: works from the orb, the tray icon, and hotkeys — even if
  // the window was closed, hidden, or its reference went stale.
  try {
    if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) {
      chatWin.hide();
      return;
    }
    // If the chat was auto-hidden a split second ago (blur), treat this click as "close".
    if (Date.now() - chatAutoHiddenAt < 400) {
      chatAutoHiddenAt = 0;
      return;
    }
    if (chatWin && chatWin.isDestroyed()) chatWin = null;
    createChat();
    positionChatNearOverlay();
    chatWin.show();
    chatWin.focus();
    return;
  } catch (e) {
    console.error('[Orbit] toggleChat failed, recovering:', e);
  }
  // Recovery path — rebuild the window from scratch no matter what.
  try {
    chatWin = null;
    createChat();
    positionChatNearOverlay();
    chatWin.show();
    chatWin.focus();
  } catch (e2) {
    console.error('[Orbit] toggleChat recovery failed:', e2);
  }
  chatWin.webContents.send('agent:event', { type: 'focus_input' });
}

/* ---------------------------------- tray ---------------------------------- */

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'icons', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip(`Orbit AI — click here to open chat · ${store.get('hotkey')} toggles the floating button`);
  const menu = Menu.buildFromTemplate([
    { label: 'Open Orbit AI', click: () => showMainWindow() },
    { label: 'Toggle floating button', click: () => showOverlay(!store.get('overlayActive')) },
    { label: 'Open chat', click: () => toggleChat() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  // Single left-click on the tray orbit opens/toggles the chat (Windows: fires even with a context menu).
  tray.on('click', () => toggleChat());
  tray.on('double-click', () => showMainWindow());
}

/* --------------------------------- hotkey --------------------------------- */

let hotkeyRegistered = false;

function registerHotkey() {
  globalShortcut.unregisterAll();
  const hk = store.get('hotkey', 'Alt+Space');
  let ok = false;
  try {
    ok = globalShortcut.register(hk, toggleOverlayFromHotkey);
  } catch {}
  if (!ok && hk !== 'Control+Alt+Space') {
    try {
      ok = globalShortcut.register('Control+Alt+Space', toggleOverlayFromHotkey);
    } catch {}
    if (ok) {
      store.set('hotkey', 'Control+Alt+Space');
      if (tray) tray.setToolTip('Orbit AI — Control+Alt+Space toggles the floating button');
    }
  }
  hotkeyRegistered = ok;
  // Quick-capture hotkey (select text anywhere → popup). Fallback if Alt+Q is taken.
  let qok = false;
  for (const qhk of ['Alt+Q', 'Alt+Shift+Q', 'Control+Alt+Q']) {
    try {
      qok = globalShortcut.register(qhk, toggleQuickCapture);
    } catch {}
    if (qok) break;
  }
  broadcast('hotkey:changed', { registered: ok, hotkey: store.get('hotkey') });
}

function toggleOverlayFromHotkey() {
  showOverlay(!store.get('overlayActive'));
}

/* ----------------------------------- IPC ----------------------------------- */

function broadcast(channel, payload) {
  for (const w of [mainWindow, chatWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function registerIpc() {
  // ---- config ----
  ipcMain.handle('config:get', () => store.data);

  ipcMain.handle('config:set', (_e, patch) => {
    const clean = patch && typeof patch === 'object' ? patch : {};
    if ('hotkey' in clean) {
      store.set('hotkey', String(clean.hotkey || '').trim() || 'Alt+Space');
      registerHotkey();
    }
    if ('launchOnStartup' in clean) {
      store.set('launchOnStartup', !!clean.launchOnStartup);
      app.setLoginItemSettings({ openAtLogin: !!clean.launchOnStartup, args: ['--hidden'] });
    }
    const passthrough = {};
    for (const k of ['keys', 'provider', 'models', 'systemPrompt', 'temperature', 'autoHideChat', 'showSkills', 'skills', 'localBaseUrl', 'voiceSettings', 'pcControl']) {
      if (k in clean) passthrough[k] = clean[k];
    }
    if (Object.keys(passthrough).length) store.patch(passthrough);
    broadcast('config:changed', store.data);
    return store.data;
  });

  // ---- models / keys ----
  ipcMain.handle('models:list', (_e, provider) => {
    const keys = store.get('keys', {});
    return listModels(provider, keys[provider], store.get('localBaseUrl', ''));
  });

  ipcMain.handle('keys:test', async (_e, provider) => {
    // REAL test: sends a tiny chat completion. Only a genuine provider reply
    // reports "working" — a wrong key can never pass.
    const keys = store.get('keys', {});
    const models = store.get('models', {});
    return testKeyReal(provider, keys[provider], models[provider], store.get('localBaseUrl', ''));
  });

  // ---- screenshots (vision) ----
  ipcMain.handle('screen:capture', async () => {
    try {
      const { size, scaleFactor } = screen.getPrimaryDisplay();
      const w = Math.min(Math.round(size.width * scaleFactor), 3200);
      const h = Math.min(Math.round(size.height * scaleFactor), 2000);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
      const src = sources && sources[0];
      if (!src) return { ok: false, error: 'No screen found to capture' };
      return { ok: true, dataUrl: src.thumbnail.toDataURL(), name: src.name || 'screen' };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ---- overlay ----
  ipcMain.handle('overlay:show', (_e, show) => {
    showOverlay(!!show);
    return store.get('overlayActive');
  });

  ipcMain.handle('overlay:state', () => ({
    active: store.get('overlayActive'),
    hotkey: store.get('hotkey'),
    hotkeyOk: hotkeyRegistered
  }));

  ipcMain.on('overlay:open-chat', () => toggleChat());

  ipcMain.on('overlay:drag-start', () => {
    drag = { moved: 0 };
  });

  ipcMain.on('overlay:drag-delta', (_e, { dx, dy }) => {
    if (!drag || !overlayWin || overlayWin.isDestroyed()) return;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    const b = overlayWin.getBounds();
    const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const wa = display.workArea;
    const nx = Math.max(wa.x - 8, Math.min(b.x + dx, wa.x + wa.width - b.width + 8));
    const ny = Math.max(wa.y - 8, Math.min(b.y + dy, wa.y + wa.height - b.height + 8));
    overlayWin.setPosition(nx, ny);
  });

  ipcMain.on('overlay:drag-end', () => {
    const moved = drag ? drag.moved : 0;
    drag = null;
    const pos = overlayWin && !overlayWin.isDestroyed() ? overlayWin.getBounds() : null;
    if (pos) store.set('overlayPos', { x: pos.x, y: pos.y });
    if (moved < 8) toggleChat();
  });

  ipcMain.on('overlay:menu', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const cur = store.get('provider', 'groq');
    const models = store.get('models', {});
    const curModel = models[cur] || 'no model picked';
    const menu = Menu.buildFromTemplate([
      { label: '💬 Chat with AI', click: () => toggleChat() },
      { type: 'separator' },
      { label: `Model: ${PROVIDERS[cur]?.label || cur} · ${curModel}`, enabled: false },
      {
        label: 'Switch provider',
        submenu: Object.values(PROVIDERS).map((p) => ({
          label: p.label + (p.id === cur ? '  ✓' : ''),
          click: () => switchProvider(p.id)
        }))
      },
      { label: '🔍 Pick model…', click: () => openModelPicker() },
      { type: 'separator' },
      { label: '⚙️ Settings', click: () => showMainWindow() },
      { label: '🙈 Hide floating button', click: () => showOverlay(false) }
    ]);
    menu.popup({ window: overlayWin });
  });

  // ---- chat ----
  ipcMain.handle('chat:send', async (e, { messages, fromCall, chatId }) => {
    chatAbort = new AbortController();
    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (ev) => {
      const target = win && !win.isDestroyed() ? win : chatWin;
      if (target && !target.isDestroyed()) target.webContents.send('agent:event', ev);
    };
    try {
      const finalMessages = await runTurn({
        store,
        mcp,
        pc,
        mem,
        messages: Array.isArray(messages) ? messages : [],
        signal: chatAbort.signal,
        send,
        callMode: !!fromCall
      });
      const cleaned = stripImagesForStorage(finalMessages).slice(-400); // generous history: heavy tool turns eat slots fast
      const chats = store.get('chats', []);
      // Trust the SENDER's chat id first — a stale/missing activeChatId used to
      // fork the conversation into a brand-new chat (looked like messages vanished).
      let id = (chatId && chats.some((c) => c.id === chatId)) ? chatId : store.get('activeChatId', null);
      let chat = chats.find((c) => c.id === id);
      if (!chat) {
        id = 'c_' + Date.now().toString(36);
        chat = { id, title: 'New chat', created: Date.now(), updated: Date.now(), messages: [] };
        chats.unshift(chat);
        store.set('activeChatId', id);
      }
      chat.messages = cleaned;
      const firstUser = cleaned.find((m) => m.role === 'user');
      const titleSrc = Array.isArray(firstUser && firstUser.content)
        ? ((firstUser.content.find((p) => p.type === 'text') || {}).text || '')
        : (firstUser && firstUser.content) || '';
      if (titleSrc) chat.title = String(titleSrc).slice(0, 42);
      chat.updated = Date.now();
      store.set('chats', chats.slice(0, 50));
      broadcast('chats:changed');
      return { ok: true, chatId: id };
    } catch (err) {
      send({ type: 'error', message: err.message || String(err) });
      return { ok: false };
    }
  });

  // Keep base64 images out of config.json — after the turn, replace image
  // parts with a note. The live conversation keeps them; history reloads text-only.
  function stripImagesForStorage(msgs) {
    return (msgs || []).map((m) => {
      if (Array.isArray(m.content)) {
        const hadImage = m.content.some((p) => p && p.type === 'image_url');
        const text = m.content
          .map((p) => (p && p.type === 'text' ? p.text : ''))
          .filter(Boolean)
          .join('\n');
        return { ...m, content: text + (hadImage ? '\n[image attached]' : '') };
      }
      return m;
    });
  }

  ipcMain.on('chat:stop', () => {
    if (chatAbort) chatAbort.abort();
  });

  ipcMain.handle('chat:history', () => {
    const id = store.get('activeChatId', null);
    const chat = store.get('chats', []).find((c) => c.id === id);
    return chat ? chat.messages : [];
  });

  ipcMain.handle('chat:clear', () => {
    const id = store.get('activeChatId', null);
    const chats = store.get('chats', []);
    const chat = chats.find((c) => c.id === id);
    if (chat) {
      chat.messages = [];
      chat.title = 'New chat';
      chat.updated = Date.now();
      store.set('chats', chats);
      broadcast('chats:changed');
    }
    return true;
  });

  // ---- multi-chat ----
  ipcMain.handle('chats:list', () =>
    store
      .get('chats', [])
      .map((c) => ({ id: c.id, title: c.title, updated: c.updated }))
      .sort((a, b) => b.updated - a.updated)
  );

  ipcMain.handle('chats:open', (_e, id) => {
    const chat = store.get('chats', []).find((c) => c.id === id);
    if (!chat) return { messages: [] };
    store.set('activeChatId', id);
    return { messages: chat.messages };
  });

  ipcMain.handle('chats:new', () => {
    const id = 'c_' + Date.now().toString(36);
    const chats = store.get('chats', []);
    chats.unshift({ id, title: 'New chat', created: Date.now(), updated: Date.now(), messages: [] });
    store.set('chats', chats.slice(0, 50));
    store.set('activeChatId', id);
    broadcast('chats:changed');
    return { id };
  });

  ipcMain.handle('chats:delete', (_e, id) => {
    store.set('chats', store.get('chats', []).filter((c) => c.id !== id));
    if (store.get('activeChatId', null) === id) store.set('activeChatId', null);
    broadcast('chats:changed');
    return true;
  });

  // ---- memories ----
  ipcMain.handle('memories:list', () => mem.all());
  ipcMain.handle('memories:add', (_e, text) => mem.call('mem__memory_save', { text: String(text || '').slice(0, 200) }));
  ipcMain.handle('memories:remove', (_e, id) => {
    store.set('memories', mem.all().filter((m) => m.id !== id));
    broadcast('config:changed', store.data);
    return true;
  });

  // ---- MCP ----
  ipcMain.handle('mcp:list', () => mcp.listSummaries());
  ipcMain.handle('mcp:add', (_e, server) => mcp.add(server));
  ipcMain.handle('mcp:update', (_e, { id, patch }) => mcp.update(id, patch));
  ipcMain.handle('mcp:remove', (_e, id) => mcp.remove(id));
  ipcMain.handle('mcp:toggle', (_e, { id, enabled }) => mcp.toggle(id, enabled));
  ipcMain.handle('mcp:templates', () => TEMPLATES);

  ipcMain.handle('mcp:import-known', () => {
    const found = [];
    for (const p of knownConfigPaths()) {
      try {
        if (fs.existsSync(p)) found.push(...parseMcpConfigFile(p));
      } catch {}
    }
    return found;
  });

  ipcMain.handle('mcp:pick-file', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Pick an MCP config file (claude_desktop_config.json, mcp.json…)',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return [];
    try {
      return parseMcpConfigFile(res.filePaths[0]);
    } catch (err) {
      dialog.showErrorBox('Could not parse file', String(err.message || err));
      return [];
    }
  });

  ipcMain.handle('mcp:import-servers', async (_e, { servers }) => {
    const existing = mcp.getServers();
    let added = 0;
    let skipped = 0;
    for (const s of servers || []) {
      if (existing.some((x) => x.name === s.name)) {
        skipped++;
        continue;
      }
      await mcp.add({ name: s.name, command: s.command, args: s.args, env: s.env, enabled: false });
      added++;
    }
    return { added, skipped };
  });

  // ---- voice ----
  ipcMain.handle('voice:transcribe', (_e, { audio, lang }) =>
    transcribeGroqAudio(store.get('keys', {}).groq, audio, 'https://api.groq.com/openai/v1', ['en', 'ar'].includes(lang) ? lang : undefined)
  );

  ipcMain.handle('tts:speak', async (_e, opts) => {
    const vs = store.get('voiceSettings', {});
    const keys = store.get('keys', {});
    const voice = opts && opts.voice !== undefined ? opts.voice : vs.voice;
    const rate = opts && opts.rate !== undefined ? opts.rate : vs.rate;
    const text = (opts && opts.text) || '';
    const done = (res) => {
      if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('agent:event', { type: 'tts_done', id: (opts && opts.id) || undefined, ok: !!(res && res.ok), warn: res && res.warn });
    };
    const engine = (opts && opts.engine) || vs.ttsEngine || 'auto';
    const wantOnline = /^online ·/i.test(String(voice || ''));
    // AUTO: Arabic text, no LOCAL Arabic voice on this PC, Groq key present →
    // fetch an internet voice (Groq Orpheus) so Arabic always gets spoken.
    const isAr = isArabicText(text);
    const localAr = tts.localArabicAvailable();
    const useOnline = wantOnline || engine === 'groq' || (engine === 'auto' && isAr && localAr === false && !!keys.groq);
    if (useOnline) {
      const onlineVoice = wantOnline
        ? String(voice).replace(/^online ·\s*/i, '').split('(')[0].trim()
        : String(voice || '');
      const r = await speakGroqTts(keys.groq, { text, voice: onlineVoice });
      if (r.ok) return tts.playWavBuffer(r.wav, done);
      // internet failed → fall back to Windows voice rather than silence
      const rr = tts.speak({ text, voice: wantOnline ? '' : voice, rate }, done);
      return rr.ok ? rr : r;
    }
    return tts.speak({ text, voice, rate }, done);
  });

  ipcMain.on('tts:stop', () => tts.stop());

  ipcMain.handle('tts:voices', async () => {
    const local = await tts.listVoices();
    const online = store.get('keys', {}).groq
      ? ['Online · Noura (Arabic · internet)', 'Online · Fahad (Arabic · internet)', 'Online · Lulwa (Arabic · internet)', 'Online · Abdullah (Arabic · internet)', 'Online · Autumn (English · internet)', 'Online · Diana (English · internet)']
      : [];
    return [...local, ...online];
  });

  // ---- quick capture ----
  ipcMain.handle('quick:init', () => ({ text: quickText, arabic: AR_RE.test(quickText) }));
  ipcMain.handle('quick:recapture', async () => {
    quickText = await captureSelectedText();
    if (quickWin && !quickWin.isDestroyed()) quickWin.hide();
    return { text: quickText, arabic: AR_RE.test(quickText) };
  });
  ipcMain.handle('quick:copy', (_e, { text }) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });
  ipcMain.on('quick:close', () => {
    if (quickWin && !quickWin.isDestroyed()) quickWin.hide();
  });
  ipcMain.on('quick:stop', () => {
    if (quickAbort) quickAbort.abort();
  });
  ipcMain.handle('quick:ask', async (e, { instruction }) => {
    if (!quickText || !quickText.trim()) {
      return { ok: false, error: 'No text captured. Click "Select again", select text in any app, then press Alt+Q.' };
    }
    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (ev) => {
      if (win && !win.isDestroyed()) win.webContents.send('quick:event', ev);
    };
    quickAbort = new AbortController();
    const sys = DEFAULT_SYSTEM_PROMPT +
      '\n\n[QUICK CAPTURE MODE — a tiny popup, not the main chat. The user selected text in another app and gives a SHORT instruction about it. Apply the instruction to the quoted text. Be concise: a few sentences max unless explicitly asked for more. You have NO tools here — never pretend to run any.]';
    try {
      const out = await runTurn({
        store,
        mcp: { openAiTools: () => [], callTool: async () => ({ content: [] }) },
        pc: null,
        mem: null,
        messages: [{ role: 'user', content: String(instruction || '') + '\n\n--- Selected text ---\n' + quickText }],
        signal: quickAbort.signal,
        send,
        systemPromptOverride: sys
      });
      const last = out && out[out.length - 1];
      send({ type: 'done', text: last && last.role === 'assistant' ? last.content : '' });
      return { ok: true };
    } catch (err) {
      send({ type: 'error', message: err.message || String(err) });
      return { ok: false };
    }
  });

  // ---- model picker window ----
  ipcMain.handle('picker:init', () => store.data);
  ipcMain.handle('picker:set-model', (_e, { provider, modelId }) => {
    if (!PROVIDERS[provider] || !modelId) return { ok: false };
    const models = store.get('models', {});
    store.set('provider', provider);
    store.set('models', { ...models, [provider]: modelId });
    broadcast('config:changed', store.data);
    return { ok: true };
  });
  ipcMain.on('picker:close', () => {
    if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  });

  ipcMain.on('approval:respond', (_e, { id, allowed }) => {
    if (pc) pc.resolveApproval(id, allowed);
  });

  // Read-only self-test of the PC control engine (no approval needed).
  ipcMain.handle('pc:test', async () => {
    try {
      if (!pc) return { ok: false, error: 'not ready' };
      if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
      const r = await pc.call('pc__screen_size', {}, { send: () => {} });
      return { ok: true, info: r.text };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ---- misc ----
  ipcMain.on('app:open-main', () => showMainWindow());
  ipcMain.on('app:open-chat-call', () => {
    createChat();
    positionChatNearOverlay();
    chatWin.show();
    chatWin.focus();
    chatWin.webContents.send('agent:event', { type: 'start_call' });
  });
  ipcMain.on('app:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });
  ipcMain.on('app:quit', () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle('app:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

/* ---------------------------------- boot ---------------------------------- */

registerIpc();
