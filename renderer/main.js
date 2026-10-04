/* Orbit AI — dashboard renderer */
const api = window.orbit;
const $ = (id) => document.getElementById(id);

const PROVIDERS = {
  groq: { id: 'groq', label: 'Groq', keyUrl: 'https://console.groq.com/keys', hint: 'Extremely fast inference. Free tier available.' },
  openrouter: { id: 'openrouter', label: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys', hint: '400+ models: GPT, Claude, Gemini, Llama, DeepSeek…' },
  nvidia: { id: 'nvidia', label: 'NVIDIA NIM', keyUrl: 'https://build.nvidia.com/settings/api-keys', hint: 'NVIDIA-hosted open models (Llama, DeepSeek, Nemotron…).' },
  local: { id: 'local', label: 'Local (Hermes)', keyUrl: '', hint: 'Hermes local models, llama.cpp, Ollama, LM Studio — free, offline, private. No key needed.' }
};

const LOCAL_PRESETS = [
  { label: 'Hermes (llama.cpp)', url: 'http://localhost:8080/v1' },
  { label: 'Hermes Agent', url: 'http://localhost:8642/v1' },
  { label: 'Ollama', url: 'http://localhost:11434/v1' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1' }
];

let cfg = null;
let templates = [];
let editingServerId = null;
let hotkeyCapture = '';
let toastTimer = null;

/* ------------------------------- utilities ------------------------------- */

function toast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Parse an args string with "quoted" parts.
function parseArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function parseEnv(str) {
  const env = {};
  for (const line of (str || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

/* --------------------------------- tabs ---------------------------------- */

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});
document.querySelectorAll('.goto').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    activateTab(a.dataset.tab);
  });
});

function activateTab(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  if (name === 'connectors') refreshServers();
  if (name === 'start') refreshSteps();
  if (name === 'skills') renderSkills();
  if (name === 'voice') initVoiceTab();
  if (name === 'memory') refreshMemories();
}

/* --------------------------------- memory --------------------------------- */

async function refreshMemories() {
  const list = await api.memories.list();
  $('memCount').textContent = list.length;
  const wrap = $('memList');
  if (!list.length) {
    wrap.innerHTML = '<div class="hint" style="text-align:center;padding:16px">Nothing remembered yet — chat with Orbit and tell it about yourself, or add a fact below.</div>';
    return;
  }
  wrap.innerHTML = '';
  for (const m of list) {
    const el = document.createElement('div');
    el.className = 'memory-item';
    el.innerHTML = '<span class="m-text">' + esc(m.text) + '</span><button class="mini-btn danger">Forget</button>';
    el.querySelector('button').addEventListener('click', async () => {
      await api.memories.remove(m.id);
      refreshMemories();
    });
    wrap.appendChild(el);
  }
}
$('memAddBtn').addEventListener('click', async () => {
  const v = $('memNew').value.trim();
  if (!v) return;
  await api.memories.add(v);
  $('memNew').value = '';
  refreshMemories();
  toast('Remembered ✓', 'ok');
});
$('memNew').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('memAddBtn').click();
});

/* ---------------------------------- voice --------------------------------- */

let voiceTabReady = false;

async function initVoiceTab() {
  const vs = cfg.voiceSettings || {};
  $('speakReplies').checked = !!vs.speakReplies;
  $('sttAutoSend').checked = vs.sttAutoSend !== false;
  $('callLangSelect').value = vs.callLang || 'auto';
  $('micPickupSelect').value = vs.micPickup || 'near';
  $('voiceRate').value = vs.rate ?? 0;
  $('voiceRateVal').textContent = vs.rate ?? 0;
  if (!voiceTabReady) {
    voiceTabReady = true;
    await refreshVoices();
  } else {
    $('voiceSelect').value = vs.voice || '';
  }
}

async function refreshVoices() {
  const sel = $('voiceSelect');
  sel.innerHTML = '<option value="">System default</option>';
  $('voiceListHint').textContent = 'Loading installed voices…';
  const voices = await api.ttsVoices();
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  }
  const vs = cfg.voiceSettings || {};
  sel.value = voices.includes(vs.voice) ? vs.voice : '';
  const hasArabic = voices.some((v) => /arabic|hoda|naayf|asma|hamed|laila|taim|saleem/i.test(v));
  const hasOnline = voices.some((v) => /^online ·/i.test(v));
  $('voiceListHint').textContent = voices.length
    ? `${voices.length} voice(s) found.${hasOnline ? ' "Online ·" voices run over the internet (Groq) — best Arabic quality, no Windows setup needed.' : ' Add a free Groq key to unlock Online voices.'}${hasArabic ? ' Local Arabic voice ✓.' : ' For LOCAL Arabic speech: Windows Settings → Time & Language → Speech → Add voices → العربية (or just use an Online · voice).'}`
    : 'No voices found (built-in TTS works on Windows only). Replies will be silent.';
}

function saveVoiceSettings(patch) {
  return save({ voiceSettings: { ...(cfg.voiceSettings || {}), ...patch } }, true);
}
$('speakReplies').addEventListener('change', (e) => saveVoiceSettings({ speakReplies: e.target.checked }).then(() => toast(e.target.checked ? 'Orbit will speak its replies 🔊' : 'Voice replies off')));
$('sttAutoSend').addEventListener('change', (e) => saveVoiceSettings({ sttAutoSend: e.target.checked }));
$('voiceRate').addEventListener('input', () => ($('voiceRateVal').textContent = $('voiceRate').value));
$('voiceRate').addEventListener('change', () => saveVoiceSettings({ rate: parseInt($('voiceRate').value, 10) }));
$('voiceSelect').addEventListener('change', () => saveVoiceSettings({ voice: $('voiceSelect').value }));
$('callLangSelect').addEventListener('change', () => saveVoiceSettings({ callLang: $('callLangSelect').value }));
$('micPickupSelect').addEventListener('change', () => saveVoiceSettings({ micPickup: $('micPickupSelect').value }));
$('voiceTestBtn').addEventListener('click', async () => {
  const r = await api.ttsSpeak({
    text: "Hi! I'm Orbit, your desktop assistant. Voice is working.",
    voice: $('voiceSelect').value,
    rate: parseInt($('voiceRate').value, 10)
  });
  toast(r && r.ok ? 'Speaking…' : (r && r.error) || 'Failed', r && r.ok ? 'ok' : 'err');
});

/* -------------------------------- config --------------------------------- */

async function save(patch, silent) {
  cfg = await api.setConfig(patch);
  if (!silent) toast('Saved ✓', 'ok');
  refreshSteps();
  return cfg;
}

/* ------------------------------ title bar -------------------------------- */

$('minBtn').addEventListener('click', () => api.minimize());
$('closeBtn').addEventListener('click', () => window.close());

/* ----------------------------- get started ------------------------------- */

function refreshSteps() {
  const keys = cfg.keys || {};
  const hasKey = Object.values(keys).some((k) => k && k.trim());
  const s1 = $('step1State');
  s1.textContent = hasKey ? '✓ Done — key saved' : '○ Not done yet';
  s1.className = 'step-state ' + (hasKey ? 'done' : 'todo');

  const model = (cfg.models || {})[cfg.provider];
  const s2 = $('step2State');
  s2.textContent = model ? `✓ ${PROVIDERS[cfg.provider]?.label || cfg.provider} · ${model}` : '○ Not done yet';
  s2.className = 'step-state ' + (model ? 'done' : 'todo');

  const s3 = $('step3State');
  s3.textContent = cfg.overlayActive ? '✓ Active — drag the orb anywhere!' : '○ Not activated yet';
  s3.className = 'step-state ' + (cfg.overlayActive ? 'done' : 'todo');

  const done = (hasKey ? 1 : 0) + (model ? 1 : 0) + (cfg.overlayActive ? 1 : 0);
  $('navStatus').innerHTML = `Setup: ${done}/3 done<br>` +
    (cfg.hotkey ? `Hotkey: <b>${esc(cfg.hotkey)}</b>` : '');
}

/* ------------------------------ connection ------------------------------- */

function renderProviderCards() {
  const wrap = $('providerCards');
  wrap.innerHTML = '';
  for (const p of Object.values(PROVIDERS)) {
    const card = document.createElement('div');
    card.className = 'provider-card';
    if (p.id === 'local') {
      card.innerHTML = `
        <h3>${p.label}</h3>
        <div class="hint">${p.hint}</div>
        <div class="preset-row" id="localPresets"></div>
        <div class="field"><label>Server Base URL</label>
          <input type="text" id="localBaseUrl" placeholder="http://localhost:8080/v1" spellcheck="false" />
        </div>
        <div class="key-row">
          <input type="text" id="key-local" placeholder="API key — usually leave this empty" spellcheck="false" />
        </div>
        <div class="hint" style="margin:-4px 0 2px">No API key needed for local AI — just click <b>Test connection</b>.</div>
        <div class="provider-status" id="status-local"></div>
        <div class="provider-links"><a href="#" data-test="local">Test connection</a></div>`;
    } else {
      card.innerHTML = `
        <h3>${p.label}</h3>
        <div class="hint">${p.hint}</div>
        <div class="key-row">
          <input type="text" id="key-${p.id}" placeholder="${p.label} API key" spellcheck="false" />
        </div>
        <div class="provider-status" id="status-${p.id}"></div>
        <div class="provider-links">
          <a href="#" data-url="${p.keyUrl}">Get a key ↗</a>
          <a href="#" data-test="${p.id}">Test</a>
        </div>`;
    }
    wrap.appendChild(card);
  }

  // local presets + base url wiring
  const presetsEl = document.getElementById('localPresets');
  if (presetsEl) {
    for (const pr of LOCAL_PRESETS) {
      const b = document.createElement('button');
      b.className = 'preset-btn';
      b.textContent = pr.label;
      b.title = pr.url;
      b.addEventListener('click', async () => {
        document.getElementById('localBaseUrl').value = pr.url;
        cfg = await api.setConfig({ localBaseUrl: pr.url });
        toast('Base URL set: ' + pr.url, 'ok');
      });
      presetsEl.appendChild(b);
    }
    const baseInput = document.getElementById('localBaseUrl');
    baseInput.value = cfg.localBaseUrl || 'http://localhost:8080/v1';
    baseInput.addEventListener('change', async () => {
      cfg = await api.setConfig({ localBaseUrl: baseInput.value.trim() });
      toast('Base URL saved', 'ok');
    });
  }

  wrap.querySelectorAll('[data-url]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      api.openExternal(a.dataset.url);
    })
  );
  wrap.querySelectorAll('[data-test]').forEach((a) =>
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = a.dataset.test;
      const st = $('status-' + id);
      st.textContent = 'Testing…';
      st.className = 'provider-status';
      await saveKey(id, true);
    })
  );
  wrap.querySelectorAll('input[id^="key-"]').forEach((inp) =>
    inp.addEventListener('change', () => saveKey(inp.id.replace('key-', ''), false))
  );
}

async function saveKey(providerId, andTest) {
  const val = $('key-' + providerId).value.trim();
  cfg = await api.setConfig({ keys: { ...cfg.keys, [providerId]: val } });
  const st = $('status-' + providerId);
  if (!andTest) {
    st.textContent = val
      ? 'Saved — click Test to verify it really works'
      : providerId === 'local'
        ? 'No key needed — just click Test connection'
        : 'Key cleared';
    st.className = 'provider-status';
    refreshSteps();
    return;
  }
  if (!val && providerId !== 'local') {
    // Local servers usually run with NO key — only cloud providers require one.
    st.textContent = 'No key entered.';
    st.className = 'provider-status err';
    return;
  }
  st.textContent = providerId === 'local' ? 'Testing… pinging your local server' : 'Testing… sending a tiny real message to the provider';
  st.className = 'provider-status';
  const res = await api.testKey(providerId);
  if (res.ok) {
    st.textContent = providerId === 'local'
      ? `✓ Local AI is working — replied via ${res.modelUsed}`
      : `✓ Really working — test message got a reply via ${res.modelUsed}`;
    st.className = 'provider-status ok';
  } else if (res.rateLimited) {
    st.textContent = '⚠ Key is VALID but rate-limited right now (free-tier quota). Try again later.';
    st.className = 'provider-status err';
  } else {
    st.textContent = '✗ ' + (res.error || 'failed');
    st.className = 'provider-status err';
  }
  refreshSteps();
}

async function fillDefaultModelList() {
  const prov = $('defaultProvider').value;
  const models = await api.listModels(prov);
  $('defaultModelList').innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  $('modelHint').textContent = `${models.length} models available for ${PROVIDERS[prov].label}. Type to search, or paste any model id.`;
}

$('defaultProvider').addEventListener('change', async () => {
  const prov = $('defaultProvider').value;
  $('defaultModel').value = (cfg.models || {})[prov] || '';
  await fillDefaultModelList();
});
$('defaultModel').addEventListener('change', () =>
  save({ models: { ...cfg.models, [$('defaultProvider').value]: $('defaultModel').value.trim() } })
);
$('refreshModelsBtn').addEventListener('click', fillDefaultModelList);

$('savePersonalityBtn').addEventListener('click', () =>
  save({ systemPrompt: $('systemPrompt').value, temperature: parseFloat($('temperature').value) })
);
$('temperature').addEventListener('input', () => ($('tempVal').textContent = $('temperature').value));

/* ---------------------------- floating button ---------------------------- */

async function refreshOverlayTab() {
  const active = cfg.overlayActive;
  const btn = $('activateBtn');
  btn.textContent = active ? 'Deactivate' : 'Activate';
  btn.classList.toggle('danger', !!active);
  $('overlayHint').textContent = active
    ? 'The orb is on your screen now — drag it anywhere, click it to chat, right-click for the menu.'
    : 'A glowing orb will appear on top of all your windows.';
  $('autoHideChat').checked = !!cfg.autoHideChat;
  $('launchOnStartup').checked = !!cfg.launchOnStartup;
  $('hotkeyInput').value = cfg.hotkey || '';
  updateHotkeyStatus(cfg.hotkeyOk !== false);
}

$('activateBtn').addEventListener('click', async () => {
  cfg = await api.setConfig(await (async () => {
    const show = !cfg.overlayActive;
    await api.showOverlay(show);
    return { overlayActive: show };
  })());
  refreshOverlayTab();
  refreshSteps();
  toast(cfg.overlayActive ? 'Floating button activated ✓' : 'Floating button hidden', 'ok');
});

$('autoHideChat').addEventListener('change', (e) => save({ autoHideChat: e.target.checked }));
$('launchOnStartup').addEventListener('change', (e) => save({ launchOnStartup: e.target.checked }));

/* hotkey capture */
$('hotkeyInput').addEventListener('focus', () => {
  hotkeyCapture = '';
  $('hotkeyInput').value = 'press keys…';
  $('hotkeyInput').style.borderColor = 'var(--accent)';
});
$('hotkeyInput').addEventListener('blur', () => {
  $('hotkeyInput').style.borderColor = '';
  $('hotkeyInput').value = hotkeyCapture || cfg.hotkey || '';
});
$('hotkeyInput').addEventListener('keydown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  let key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(key)) {
    $('hotkeyInput').value = parts.join('+') + '…';
    return;
  }
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (/^(Arrow|F\d|Page|Home|End|Insert|Delete)/.test(key)) {
    key = key.replace('Arrow', '');
    if (/^(Up|Down|Left|Right)$/.test(key)) key = { Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right' }[key];
  } else if (key === 'Escape') {
    $('hotkeyInput').value = cfg.hotkey || '';
    $('hotkeyInput').blur();
    return;
  }
  parts.push(key);
  hotkeyCapture = parts.join('+');
  $('hotkeyInput').value = hotkeyCapture;
});
$('hotkeySaveBtn').addEventListener('click', async () => {
  if (!hotkeyCapture) {
    toast('Press keys in the field first (e.g. hold Ctrl+Alt and press O)', 'err');
    return;
  }
  cfg = await api.setConfig({ hotkey: hotkeyCapture });
  hotkeyCapture = '';
  updateHotkeyStatus(cfg.hotkeyOk !== false);
  toast(`Hotkey set: ${cfg.hotkey}`, 'ok');
});

function updateHotkeyStatus(ok) {
  const el = $('hotkeyStatus');
  if (ok) {
    el.textContent = '✓ registered';
    el.className = 'status-text ok';
  } else {
    el.textContent = '⚠ could not register — try another combo';
    el.className = 'status-text err';
  }
}

/* ------------------------------ connectors ------------------------------- */

async function refreshServers() {
  const servers = await api.mcp.list();
  const wrap = $('serverList');
  if (!servers.length) {
    wrap.innerHTML = '<div class="server-empty">No connectors yet. Add one above or click a template below 👇</div>';
    return;
  }
  wrap.innerHTML = '';
  for (const s of servers) {
    const el = document.createElement('div');
    el.className = 'server-item';
    const cmd = [s.command, ...(s.args || [])].join(' ');
    el.innerHTML = `
      <div class="server-head">
        <span class="server-status ${esc(s.status)}" title="${esc(s.status)}"></span>
        <span class="server-name">${esc(s.name)}</span>
        <span class="server-cmd" title="${esc(cmd)}">${esc(cmd)}</span>
        <label class="toggle" style="margin:0" title="Enable / disable">
          <input type="checkbox" data-toggle="${s.id}" ${s.enabled ? 'checked' : ''} />
        </label>
        <button class="mini-btn" data-edit="${s.id}">Edit</button>
        <button class="mini-btn danger" data-del="${s.id}">✕</button>
      </div>
      ${s.error ? `<div class="server-error">⚠ ${esc(s.error)}</div>` : ''}
      ${s.tools.length ? `<div class="server-tools">${s.tools.map((t) => `<span class="tool-tag" title="${esc(t.description)}">${esc(t.name)}</span>`).join('')}</div>` : ''}`;
    wrap.appendChild(el);
  }

  wrap.querySelectorAll('[data-toggle]').forEach((inp) =>
    inp.addEventListener('change', async () => {
      await api.mcp.toggle(inp.dataset.toggle, inp.checked);
      refreshServers();
    })
  );
  wrap.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api.mcp.remove(b.dataset.del);
      toast('Connector removed');
      refreshServers();
    })
  );
  wrap.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = servers.find((x) => x.id === b.dataset.edit);
      editingServerId = s.id;
      $('addServerTitle').textContent = 'Edit connector';
      $('srvName').value = s.name;
      $('srvCommand').value = s.command;
      $('srvArgs').value = (s.args || []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
      $('srvEnv').value = Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
      $('srvEnabled').checked = s.enabled;
      $('addServerForm').classList.remove('hidden');
    })
  );
}

function resetServerForm() {
  editingServerId = null;
  $('addServerTitle').textContent = 'Add MCP server';
  $('srvName').value = '';
  $('srvCommand').value = '';
  $('srvArgs').value = '';
  $('srvEnv').value = '';
  $('srvEnabled').checked = true;
}

$('addServerBtn').addEventListener('click', () => {
  resetServerForm();
  $('addServerForm').classList.remove('hidden');
  $('srvName').focus();
});
$('srvCancelBtn').addEventListener('click', () => $('addServerForm').classList.add('hidden'));
$('srvSaveBtn').addEventListener('click', async () => {
  const name = $('srvName').value.trim();
  const command = $('srvCommand').value.trim();
  if (!name || !command) {
    toast('Name and command are required', 'err');
    return;
  }
  const payload = {
    name,
    command,
    args: parseArgs($('srvArgs').value),
    env: parseEnv($('srvEnv').value),
    enabled: $('srvEnabled').checked
  };
  try {
    if (editingServerId) {
      await api.mcp.update(editingServerId, payload);
    } else {
      await api.mcp.add(payload);
    }
    $('addServerForm').classList.add('hidden');
    resetServerForm();
    toast('Connector saved ✓', 'ok');
    refreshServers();
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  }
});

async function renderTemplates() {
  templates = await api.mcp.templates();
  const wrap = $('templateList');
  wrap.innerHTML = '';
  for (const t of templates) {
    const el = document.createElement('div');
    el.className = 'template-item';
    el.innerHTML = `<h4>${esc(t.name)}</h4><p>${esc(t.description)}</p>`;
    el.addEventListener('click', async () => {
      try {
        await api.mcp.add({ name: t.name, command: t.command, args: t.args, env: t.env || {}, enabled: true });
        toast(`Added "${t.name}" — connecting…`, 'ok');
        refreshServers();
      } catch (e) {
        toast('Failed: ' + e.message, 'err');
      }
    });
    wrap.appendChild(el);
  }
}

async function importFlow(servers) {
  if (!servers || !servers.length) {
    toast('No MCP servers found in any config file. Install one first, or pick a file manually.', 'err');
    return;
  }
  const res = await api.mcp.importServers(servers);
  toast(`Imported ${res.added} connector(s)${res.skipped ? `, skipped ${res.skipped} duplicate(s)` : ''} — enable the ones you want`, 'ok');
  refreshServers();
  activateTab('connectors');
}
$('importClaudeBtn').addEventListener('click', async () => importFlow(await api.mcp.importKnown()));
$('pickConfigBtn').addEventListener('click', async () => importFlow(await api.mcp.pickFile()));

api.on('mcp:changed', () => {
  if (!$('tab-connectors').classList.contains('hidden')) refreshServers();
});

/* --------------------------------- skills -------------------------------- */

function renderSkills() {
  $('showSkills').checked = !!cfg.showSkills;
  const wrap = $('skillList');
  wrap.innerHTML = '';
  if (!(cfg.skills || []).length) {
    wrap.innerHTML = '<div class="hint" style="text-align:center;padding:14px">No skills yet — add one below.</div>';
    return;
  }
  for (const s of cfg.skills) {
    const el = document.createElement('div');
    el.className = 'skill-item';
    el.innerHTML = `
      <span class="s-name">${esc(s.name)}</span>
      <span class="s-prompt" title="${esc(s.prompt)}">${esc(s.prompt)}</span>
      <button class="mini-btn danger" data-del="${esc(s.id)}">Delete</button>`;
    wrap.appendChild(el);
  }
  wrap.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await save({ skills: cfg.skills.filter((s) => s.id !== b.dataset.del) }, true);
      renderSkills();
    })
  );
}

$('showSkills').addEventListener('change', (e) => save({ showSkills: e.target.checked }, true));
$('skillAddBtn').addEventListener('click', async () => {
  const name = $('skillName').value.trim();
  const prompt = $('skillPrompt').value;
  if (!name || !prompt) {
    toast('Give the skill a name and a prompt', 'err');
    return;
  }
  const skills = [...(cfg.skills || []), { id: 'sk_' + Math.random().toString(36).slice(2, 8), name, prompt }];
  await save({ skills }, true);
  $('skillName').value = '';
  $('skillPrompt').value = '';
  renderSkills();
  toast('Skill added ✓', 'ok');
});

/* ------------------------------- PC control ------------------------------- */

function refreshPcCard() {
  const pc = cfg.pcControl || { enabled: false, mode: 'confirm' };
  $('pcEnabled').checked = !!pc.enabled;
  $('pcMode').value = pc.mode === 'auto' ? 'auto' : 'confirm';
}
$('pcEnabled').addEventListener('change', (e) =>
  save({ pcControl: { ...(cfg.pcControl || {}), enabled: e.target.checked } }).then(() =>
    toast(e.target.checked ? 'PC control ON — Orbit will ask before acting' : 'PC control off')
  )
);
$('pcMode').addEventListener('change', (e) =>
  save({ pcControl: { ...(cfg.pcControl || {}), mode: e.target.value } }).then(() =>
    toast(e.target.value === 'auto' ? '⚠ Full auto: Orbit will act without asking!' : 'Confirm-everything mode', e.target.value === 'auto' ? 'err' : 'ok')
  )
);
$('pcTestBtn').addEventListener('click', async () => {
  const el = $('pcTestResult');
  el.textContent = 'Testing… asking Windows for the screen size…';
  const r = await api.pcTest();
  if (r.ok) {
    el.textContent = '✓ PC control engine works — ' + r.info;
  } else {
    el.textContent = '✗ ' + (r.error || 'failed');
  }
});
$('callStartBtn').addEventListener('click', () => api.openChatCall());

/* ---------------------------------- boot ---------------------------------- */

(async function boot() {
  cfg = await api.getConfig();
  const state = await api.getOverlayState();
  cfg.hotkey = state.hotkey;
  cfg.overlayActive = state.active;
  $('versionTag').textContent = 'v' + (cfg.version || '1.0.0');
  $('aboutVersion').textContent = 'v' + (cfg.version || '1.0.0');
  updateHotkeyStatus(state.hotkeyOk !== false);

  renderProviderCards();
  for (const p of Object.values(PROVIDERS)) {
    $('key-' + p.id).value = (cfg.keys || {})[p.id] || '';
    if ((cfg.keys || {})[p.id]) {
      const st = $('status-' + p.id);
      st.textContent = 'Saved — click Test to verify it really works';
      st.className = 'provider-status';
    }
  }

  // default provider select
  const sel = $('defaultProvider');
  sel.innerHTML = Object.values(PROVIDERS).map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  sel.value = cfg.provider;
  $('defaultModel').value = (cfg.models || {})[cfg.provider] || '';
  await fillDefaultModelList();

  $('systemPrompt').value = cfg.systemPrompt || '';
  $('temperature').value = cfg.temperature ?? 0.7;
  $('tempVal').textContent = $('temperature').value;

  refreshPcCard();
  await refreshOverlayTab();
  await renderTemplates();
  renderSkills();
  refreshSteps();

  api.on('hotkey:changed', (d) => {
    cfg.hotkey = d.hotkey;
    $('hotkeyInput').value = d.hotkey;
    updateHotkeyStatus(d.registered);
  });
  api.on('overlay:changed', async (d) => {
    cfg.overlayActive = d.active;
    refreshOverlayTab();
    refreshSteps();
  });
})();
