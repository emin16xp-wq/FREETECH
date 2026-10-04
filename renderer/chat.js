/* Orbit chat — renderer logic */
const api = window.orbit;
const $ = (id) => document.getElementById(id);

const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('sendBtn');
const stopBtn = $('stopBtn');
const newChatBtn = $('newChatBtn');
const historyBtn = $('historyBtn');
const historyPanel = $('historyPanel');
const settingsBtn = $('settingsBtn');
const closeBtn = $('closeBtn');
const modelSelect = $('modelSelect');
const skillsEl = $('skills');
const noticeEl = $('notice');
const attachBtn = $('attachBtn');
const shotBtn = $('shotBtn');
const attachTray = $('attachTray');
const fileInput = $('fileInput');
const micBtn = $('micBtn');
const callBtn = $('callBtn');
const callBar = $('callBar');
const callStateEl = $('callState');
const callLevelCv = $('callLevel');
const callEndBtn = $('callEndBtn');
const readLastBtn = $('readLastBtn');
const speakBar = $('speakBar');
const speakStopBtn = $('speakStopBtn');

let messages = [];          // API messages [{role, content, ...}]
let streaming = false;
let cfg = null;
let streamBuf = null;       // { el, text, timer }
let toolWrap = null;        // current tools container for this turn
const modelCache = {};      // provider -> [{id,label}]
let pickerProvider = null;
let noticeTimer = null;
let attachments = [];       // pending: {kind:'image', dataUrl, name} | {kind:'text', name, content}

/* ---------------------------- markdown (mini) ---------------------------- */

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function md(src) {
  const blocks = [];
  src = String(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_m, lang, code) => {
    blocks.push({ lang, code: code.replace(/\n$/, '') });
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  let h = esc(src)
    .split('\n')
    .map((l) => (/^\s*[-*•]\s+/.test(l) ? '• ' + l.replace(/^\s*[-*•]\s+/, '') : l))
    .join('\n');
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  h = h.split('\n').join('<br>');
  h = h.replace(/\u0000B(\d+)\u0000/g, (_m, i) => {
    const b = blocks[+i];
    return `<pre><div class="lang">${esc(b.lang || 'code')}</div><code>${esc(b.code)}</code></pre>`;
  });
  return h;
}

messagesEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a) {
    e.preventDefault();
    api.openExternal(a.href);
  }
});

/* -------------------------------- rendering ------------------------------- */

function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}
function autoScroll(force) {
  if (force || nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addBubble(role, content, force = true) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'user' && Array.isArray(content)) {
    // multimodal message: text + images
    let html = '';
    for (const part of content) {
      if (part.type === 'text' && part.text) html += esc(part.text).replace(/\n/g, '<br>');
      if (part.type === 'image_url') html += `<img class="thumb" src="${part.image_url.url}" alt="attached image" />`;
    }
    div.innerHTML = html;
  } else if (role === 'assistant') {
    div.innerHTML = md(content);
  } else {
    div.innerHTML = esc(content).replace(/\n/g, '<br>');
  }
  messagesEl.appendChild(div);
  autoScroll(force);
  return div;
}

function renderHistory() {
  messagesEl.innerHTML = '';
  if (!messages.length) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <div class="big-orb"></div>
        <h2>Hey! I'm Orbit 👋</h2>
        <p>Your AI that lives on your desktop — it can see your screen,<br>use your mouse & keyboard, read files and search the web.</p>
        <div class="suggests">
          <button class="skill-chip" data-say="What can you do?">✨ What can you do?</button>
          <button class="skill-chip" data-say="Take a screenshot and tell me what you see">📸 Describe my screen</button>
          <button class="skill-chip" data-say="Search the internet for the latest AI news">🌐 Search the web</button>
          <button class="skill-chip" data-say="What's using my CPU and RAM right now?">⚙️ System check</button>
        </div>
      </div>`;
    messagesEl.querySelectorAll('[data-say]').forEach((b) =>
      b.addEventListener('click', () => send(b.dataset.say))
    );
    return;
  }
  for (const m of messages) {
    if (m.role === 'user') addBubble('user', m.content);
    else if (m.role === 'assistant' && m.content) addBubble('assistant', m.content);
  }
  autoScroll(true);
}

let typingEl = null;
function showTyping() {
  if (typingEl) return;
  typingEl = document.createElement('div');
  typingEl.className = 'msg assistant typing';
  typingEl.innerHTML = '<span class="tdot"></span><span class="tdot"></span><span class="tdot"></span>';
  messagesEl.appendChild(typingEl);
  autoScroll();
}
function hideTyping() {
  if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

function newToolsWrap() {
  const wrap = document.createElement('div');
  wrap.className = 'tools';
  messagesEl.appendChild(wrap);
  return wrap;
}

function toolChip(ev) {
  hideTyping();
  if (!toolWrap) toolWrap = newToolsWrap();
  const chip = document.createElement('div');
  chip.className = 'tool-chip';
  chip.dataset.toolId = ev.id || '';
  chip.innerHTML = `<span class="spinner"></span>
    <span class="icon">🔧</span>
    <span class="name">${esc(ev.name)}</span>
    <span class="detail">${esc(ev.args || '')}</span>`;
  toolWrap.appendChild(chip);
  autoScroll();
  return chip;
}

function toolDone(ev) {
  if (!toolWrap) return;
  const chip = toolWrap.querySelector(`[data-tool-id="${CSS.escape(ev.id || '')}"]`) || toolWrap.lastElementChild;
  if (!chip) return;
  chip.querySelector('.spinner')?.remove();
  chip.querySelector('.icon').textContent = ev.ok ? '🔧' : '⚠️';
  const det = chip.querySelector('.detail');
  det.textContent = ev.output ? ev.output.replace(/\s+/g, ' ').slice(0, 90) : (ev.ok ? 'done' : 'error');
  chip.title = ev.output || '';
  if (!ev.ok) chip.classList.add('error');
  autoScroll();
}

function startStreamBubble() {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  messagesEl.appendChild(el);
  streamBuf = { el, text: '', timer: null };
  const flush = () => {
    if (!streamBuf) return;
    el.innerHTML = md(streamBuf.text);
    autoScroll();
  };
  streamBuf.flush = flush;
  streamBuf.timer = setInterval(flush, 60);
}

function appendStream(text) {
  hideTyping();
  if (!streamBuf) startStreamBubble();
  streamBuf.text += text;
}

function endStream() {
  hideTyping();
  if (streamBuf) {
    clearInterval(streamBuf.timer);
    streamBuf.flush();
    streamBuf = null;
  }
  toolWrap = null;
}

function showNotice(text, sticky = false, kind = '') {
  noticeEl.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  const x = document.createElement('button');
  x.className = 'n-x';
  x.title = 'Dismiss';
  x.textContent = '✕';
  x.addEventListener('click', clearNotice);
  noticeEl.appendChild(span);
  noticeEl.appendChild(x);
  noticeEl.className = 'notice ' + kind;
  clearTimeout(noticeTimer);
  if (!sticky) noticeTimer = setTimeout(() => noticeEl.classList.add('hidden'), 8000);
}

function clearNotice() {
  clearTimeout(noticeTimer);
  noticeEl.classList.add('hidden');
}

/* ---------------------------------- voice --------------------------------- */

function speakable(src) {
  return String(src)
    .replace(/```[\w-]*\n?[\s\S]*?(```|$)/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function showSpeakBar() {
  speakBar.classList.remove('hidden');
}
function hideSpeakBar() {
  speakBar.classList.add('hidden');
}

/* ------------- streaming TTS: talks WHILE the reply is being written ------------- */
/*CHUNKER-START*/
function chunkSentences(block, final) {
  const re = final
    ? /[\s\S]*?[.!?؟؛…]+["')\]]*(\s+|$)/
    : /[\s\S]*?[.!?؟؛…]+["')\]]*\s/;
  const out = [];
  let rest = String(block || '');
  let guard = 0;
  while (guard++ < 500) {
    const m = rest.match(re);
    if (!m) break;
    const raw = m[0];
    const text = raw.trim();
    if (text) out.push({ text, len: raw.length });
    rest = rest.slice(raw.length);
    if (!rest) break;
  }
  return { sents: out, rest };
}
/*CHUNKER-END*/

const streamTts = {
  enabled: false,      // this stream is being spoken
  queue: [],           // clips waiting to be spoken
  playing: false,      // a clip is currently playing
  spoken: 0,           // chars of the current stream already enqueued
  ending: false,       // stream finished — queue is draining
  pending: new Map(),  // clip id -> resolve()
  n: 0
};

function ttsWanted() {
  return call.active || !!(cfg.voiceSettings && cfg.voiceSettings.speakReplies);
}

// Called on every stream delta: enqueue every COMPLETE sentence for speech.
function pumpStreamTts() {
  if (!ttsWanted() || !streamBuf) return;
  streamTts.enabled = true;
  const plain = speakable(streamBuf.text);
  if (plain.length < streamTts.spoken) streamTts.spoken = 0; // text reflowed — start over
  const block = plain.slice(streamTts.spoken);
  const { sents } = chunkSentences(block, false);
  let consumed = 0;
  for (const sn of sents) {
    enqueueTtsClip(sn.text);
    consumed += sn.len;
  }
  streamTts.spoken += consumed;
}

function enqueueTtsClip(text) {
  streamTts.queue.push({ text, id: 'clip_' + Date.now().toString(36) + '_' + (++streamTts.n) });
  drainTtsQueue();
}

async function drainTtsQueue() {
  if (streamTts.playing) return;
  streamTts.playing = true;
  try {
    while (streamTts.queue.length) {
      const clip = streamTts.queue.shift();
      if (call.active) {
        call.ttsActive = true; // keep the mic closed while Orbit talks
        callStateEl.textContent = 'Speaking…';
      }
      showSpeakBar();
      const vs = cfg.voiceSettings || {};
      const doneP = new Promise((res) => streamTts.pending.set(clip.id, res));
      // Watchdog: never let a lost tts_done event lock the mic forever.
      const watchdog = setTimeout(() => {
        const r = streamTts.pending.get(clip.id);
        if (r) r();
      }, Math.max(20000, clip.text.length * 130) + 8000);
      try {
        const r = await api.ttsSpeak({ text: clip.text.slice(0, 3000), voice: vs.voice || '', rate: vs.rate ?? 0, id: clip.id });
        if (!(r && r.ok)) {
          const r2 = streamTts.pending.get(clip.id);
          streamTts.pending.delete(clip.id);
          if (r2) r2();
          continue;
        }
        await doneP;
      } finally {
        clearTimeout(watchdog);
      }
      streamTts.pending.delete(clip.id);
    }
  } catch {}
  streamTts.playing = false;
  finishStreamTtsIfDone();
}

function finishStreamTtsIfDone() {
  if (streamTts.playing || streamTts.queue.length || !streamTts.ending) return;
  streamTts.enabled = false;
  streamTts.ending = false;
  streamTts.spoken = 0;
  hideSpeakBar();
  if (call.active) {
    call.ttsActive = false;
    callStateEl.textContent = 'Listening… just talk';
  }
}

// Called at 'done': speak whatever wasn't spoken yet, then mark the stream as ending.
function flushStreamTts(fullText) {
  if (!streamTts.enabled) return false; // never started speaking this stream
  const plain = speakable(String(fullText || ''));
  if (plain.length < streamTts.spoken) streamTts.spoken = 0;
  const tail = plain.slice(streamTts.spoken);
  const { sents } = chunkSentences(tail, true);
  let consumed = 0;
  for (const sn of sents) {
    enqueueTtsClip(sn.text);
    consumed += sn.len;
  }
  streamTts.spoken = plain.length;
  const leftover = tail.slice(consumed).trim();
  if (leftover) enqueueTtsClip(leftover); // dangling fragment still gets a voice
  streamTts.ending = true;
  drainTtsQueue();
  return true;
}

// Short spoken status while a PC task runs in a call ("Opening it now."), so long
// tool runs don't feel like dead air. Throttled so it never becomes chatter.
const PROGRESS_PHRASES = [
  [/screenshot|read_screen_text|get_pixel|screen/i, 'Taking a look.'],
  [/launch_app|open_url/i, 'Opening it now.'],
  [/mouse|type_text|press_key|ghost_|clipboard/i, 'Doing it now.'],
  [/file|directory|search_files|write_/i, 'Checking the files.'],
  [/window|process|kill|close/i, 'One second.']
];
let lastProgressAt = 0;
function speakProgress(toolName) {
  const now = Date.now();
  if (now - lastProgressAt < 8000) return;
  lastProgressAt = now;
  const hit = PROGRESS_PHRASES.find(([re]) => re.test(String(toolName || '')));
  const phrase = hit ? hit[1] : 'Working on it.';
  streamTts.enabled = true;
  enqueueTtsClip(phrase);
  streamTts.ending = true; // nothing else coming — unlock the mic after this clip
  drainTtsQueue();
}

function resetStreamTts(stopAudio = true) {
  streamTts.enabled = false;
  streamTts.ending = false;
  streamTts.queue = [];
  streamTts.spoken = 0;
  for (const r of streamTts.pending.values()) r();
  streamTts.pending.clear();
  if (stopAudio) api.ttsStop();
}

async function speak(text) {
  const plain = speakable(text);
  if (!plain) return { ok: false };
  const vs = cfg.voiceSettings || {};
  const r = await api.ttsSpeak({ text: plain.slice(0, 4000), voice: vs.voice || '', rate: vs.rate ?? 0 });
  if (r && r.ok) showSpeakBar();
  return r || { ok: false };
}

function lastAssistantText() {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].content) return messages[i].content;
  }
  return '';
}

/* --------------------------------- sending -------------------------------- */

function setStreaming(on) {
  streaming = on;
  sendBtn.classList.toggle('hidden', on);
  stopBtn.classList.toggle('hidden', !on);
  inputEl.disabled = false;
  if (!on) inputEl.focus();
}

async function send(textOverride, opts = {}) {
  const text = (textOverride !== undefined ? String(textOverride) : inputEl.value).trim();
  if ((!text && !attachments.length) || streaming) return false;
  if (textOverride !== undefined && inputEl.value.trim() === text) inputEl.value = '';
  inputEl.value = '';

  // remove empty state if present
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  // Build the user message (with attachments → multimodal content array)
  if (attachments.length) {
    const hasImages = attachments.some((a) => a.kind === 'image');
    const fileNotes = [];
    for (const a of attachments) {
      if (a.kind === 'text') fileNotes.push(`[File: ${a.name}]\n\`\`\`\n${a.content}\n\`\`\``);
    }
    let textPart = text || '';
    if (!textPart && hasImages) textPart = 'What do you see? Walk me through it.';
    if (!textPart && fileNotes.length) textPart = 'Please read the attached file(s) and summarize the important parts.';
    if (fileNotes.length) textPart += (textPart ? '\n\n' : '') + fileNotes.join('\n\n');

    const parts = [{ type: 'text', text: textPart }];
    for (const a of attachments) {
      if (a.kind === 'image') parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    }
    messages.push({ role: 'user', content: parts });
  } else {
    messages.push({ role: 'user', content: text });
  }

  addBubble('user', messages[messages.length - 1].content);
  attachments = [];
  renderAttachments();
  toolWrap = null;
  resetStreamTts(true); // new question → stop talking immediately
  setStreaming(true);
  showTyping();
  if (opts.fromCall) armCallWatchdog();
  await api.sendChat(messages, { fromCall: !!opts.fromCall, chatId: currentChatId() });
  return true;
}

/* --- call turn watchdog: if the main process goes totally silent mid-turn,
       recover the call instead of showing typing dots forever --- */
let callTurnWatchdog = null;
function armCallWatchdog() {
  clearTimeout(callTurnWatchdog);
  callTurnWatchdog = setTimeout(() => {
    callTurnWatchdog = null;
    if (!call.active) return;
    showNotice('No reply came through — your call is still on, just talk again.', false);
    endStream();
    hideTyping();
    setStreaming(false);
    call.processing = false;
    call.ttsActive = false;
    call.approvalPending = false;
    callStateEl.textContent = 'Listening… just talk';
  }, 180000); // 3 min of ZERO events (long PC-tool runs can legitimately be slow)
}
function disarmCallWatchdog() {
  clearTimeout(callTurnWatchdog);
  callTurnWatchdog = null;
}

async function onAgentEvent(ev) {
  if (call.active && callTurnWatchdog) armCallWatchdog(); // any sign of life resets the timer
  switch (ev.type) {
    case 'focus_input':
      inputEl.focus();
      break;
    case 'delta':
      clearNotice();
      appendStream(ev.text);
      pumpStreamTts();
      break;
    case 'tool_start':
      endStreamBubbleForTools();
      toolChip(ev);
      if (call.active) speakProgress(ev.name);
      break;
    case 'tool_end':
      toolDone(ev);
      break;
    case 'notice':
      showNotice(ev.text);
      break;
    case 'done': {
      endStream();
      clearNotice();
      refreshChatList();
      if (call.active) disarmCallWatchdog(); // turn complete — idle listening is healthy
      const hushed = !!call.hush; // user barged in — never re-speak the cut-off reply
      call.hush = false;
      if (ev.messages) {
        messages = ev.messages;
        renderHistory();
        const t = lastAssistantText() || '';
        const spokeStreaming = !hushed && ttsWanted() ? flushStreamTts(t) : false;
        if (spokeStreaming) {
          // already talking sentence-by-sentence; the queue unlocks the mic when done
          if (call.active) call.processing = false;
        } else if (call.active && !hushed) {
          callStateEl.textContent = 'Speaking…';
          call.processing = false;
          if (t) {
            const rr = await speak(t);
            if (rr && rr.ok) {
              call.ttsActive = true;
            } else {
              // TTS failed → don't lock the mic forever
              call.ttsActive = false;
              callStateEl.textContent = 'Listening… just talk';
            }
          } else {
            call.ttsActive = false;
            callStateEl.textContent = 'Listening… just talk';
          }
        } else if (!hushed && cfg.voiceSettings && cfg.voiceSettings.speakReplies) {
          if (t) speak(t);
        }
      }
      setStreaming(false);
      break;
    }
    case 'error': {
      endStream();
      resetStreamTts(true);
      disarmCallWatchdog();
      showNotice(ev.message, true);
      setStreaming(false);
      if (call.active) {
        call.processing = false;
        call.ttsActive = false;
        callStateEl.textContent = 'Listening… just talk';
      }
      break;
    }
    case 'tts_done': {
      if (ev.warn === 'no-arabic-voice' && !arabicWarnShown) {
        arabicWarnShown = true;
        showNotice('No Arabic voice found on this PC. To hear Arabic: Windows Settings → Time & Language → Speech → Manage voices → Add voices → العربية, then restart Orbit.', false);
      }
      if (ev.id) {
        const res = streamTts.pending.get(ev.id);
        if (res) {
          streamTts.pending.delete(ev.id);
          res();
          break;
        }
      }
      // legacy / non-queue speech (approval prompts, fallbacks)
      hideSpeakBar();
      if (call.active && !streamTts.playing) {
        call.ttsActive = false;
        callStateEl.textContent = 'Listening… just talk';
      }
      break;
    }
    case 'approval_request':
      showApproval(ev);
      break;
    case 'open_picker':
      modelSelect.classList.add('pulse');
      setTimeout(() => modelSelect.classList.remove('pulse'), 1700);
      break;
    case 'start_call':
      startCall();
      break;
  }
}

/* ------------------------------ PC approvals ------------------------------ */

let arabicWarnShown = false;
const approvalSettlers = new Map(); // id -> settle(allowed, label)

function showApproval(ev) {
  const wrap = document.createElement('div');
  wrap.className = 'approval';
  wrap.innerHTML =
    '<div class="ap-title">🖱️ Orbit wants to use your PC</div>' +
    '<div class="ap-action">' + esc(ev.action || '') + '</div>' +
    '<div class="ap-btns"><button class="ap-allow">Allow</button><button class="ap-deny">Deny</button></div>';
  messagesEl.appendChild(wrap);
  autoScroll(true);
  const settle = (allowed, label) => {
    if (approvalSettlers.has(ev.id)) approvalSettlers.delete(ev.id);
    wrap.classList.add('settled');
    wrap.querySelector('.ap-btns').innerHTML = '<span class="ap-result">' + label + '</span>';
    api.respondApproval(ev.id, allowed);
  };
  approvalSettlers.set(ev.id, settle);
  wrap.querySelector('.ap-allow').addEventListener('click', () => settle(true, '✓ Allowed — running…'));
  wrap.querySelector('.ap-deny').addEventListener('click', () => settle(false, '✗ Denied'));

  // In call mode: ask out loud and listen for "approve" / "deny"
  if (call.active && !ev._voiceAsked) {
    ev._voiceAsked = true;
    voiceApproval(ev);
  }
}

const APPROVE_RE = /\b(approve|approved|allow|allowed|yes|yeah|yep|sure|do it|go ahead|go on|okay|ok|confirm)\b/i;
const DENY_RE = /\b(deny|denied|no|nope|cancel|stop|don'?t|do not)\b/i;

async function voiceApproval(ev) {
  call.approvalPending = true;
  const settle = approvalSettlers.get(ev.id);
  try {
    for (let attempt = 0; attempt < 3 && call.active && approvalSettlers.has(ev.id); attempt++) {
      await speak('Approval needed: ' + speakable(ev.action || 'an action') + '. Say approve, or deny.');
      if (!call.active) break;
      callStateEl.textContent = 'Say "approve" or "deny"';
      const said = await listenOnceFor(6000);
      if (!call.active || !approvalSettlers.has(ev.id)) break;
      if (said) {
        if (DENY_RE.test(said)) {
          callStateEl.textContent = 'Denied — back to you';
          if (settle) settle(false, '✗ Denied (voice)');
          return;
        }
        if (APPROVE_RE.test(said)) {
          callStateEl.textContent = 'Approved — running';
          if (settle) settle(true, '✓ Allowed (voice)');
          return;
        }
      }
      // didn't catch it → loop asks again (max 3 times)
    }
  } catch (e) {
    // fall back to buttons silently
  } finally {
    call.approvalPending = false;
    if (call.active && callStateEl) callStateEl.textContent = 'Listening… just talk';
  }
}

// Record a short clip from the call mic and transcribe it. Returns text or ''.
function listenOnceFor(ms) {
  return new Promise((resolve) => {
    if (!call.stream) return resolve('');
    let rec;
    const chunks = [];
    try {
      rec = new MediaRecorder(call.stream, { mimeType: 'audio/webm' });
    } catch {
      rec = new MediaRecorder(call.stream);
    }
    const timer = setTimeout(() => {
      try { rec.stop(); } catch {}
    }, ms);
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.onstop = async () => {
      clearTimeout(timer);
      try {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        if (blob.size < 3000) return resolve('');
        const buf = new Uint8Array(await blob.arrayBuffer());
        const r = await api.transcribe(buf, (cfg || {}).voiceSettings ? cfg.voiceSettings.callLang : undefined);
        resolve(r && r.ok ? (r.text || '').trim() : '');
      } catch {
        resolve('');
      }
    };
    rec.start();
  });
}

// If the model streams some text then calls a tool, close the partial bubble.
function endStreamBubbleForTools() {
  if (streamBuf) {
    clearInterval(streamBuf.timer);
    streamBuf.flush();
    streamBuf = null;
  }
}

/* ------------------------- model select (native) -------------------------- */

async function fillModelSelect() {
  const frag = document.createDocumentFragment();
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const group = document.createElement('optgroup');
    const hasKey = id === 'local' || (((cfg.keys || {})[id] || '').trim());
    group.label = p.label + (hasKey ? '' : '  (no key)');
    const models = modelCache[id] || [];
    if (!models.length) {
      const opt = document.createElement('option');
      opt.disabled = true;
      opt.textContent = id === 'local' ? 'server not reachable' : 'loading…';
      group.appendChild(opt);
    }
    for (const m of models.slice(0, 400)) {
      const opt = document.createElement('option');
      opt.value = id + '|' + m.id;
      opt.textContent = (m.vision ? '👁 ' : '') + (m.free ? '🆓 ' : '') + m.id;
      if (cfg.provider === id && (cfg.models || {})[id] === m.id) opt.selected = true;
      group.appendChild(opt);
    }
    frag.appendChild(group);
  }
  const more = document.createElement('option');
  more.value = '__more__';
  more.textContent = '⚙ More models & API keys…';
  frag.appendChild(more);
  modelSelect.innerHTML = '';
  modelSelect.appendChild(frag);
}

async function loadAllProviderModels() {
  await Promise.all(Object.keys(PROVIDERS).map(async (id) => {
    if (!modelCache[id]) {
      try {
        modelCache[id] = await api.listModels(id);
      } catch {
        modelCache[id] = [];
      }
    }
  }));
}

modelSelect.addEventListener('change', async () => {
  const v = modelSelect.value;
  if (v === '__more__') {
    api.openMain();
    return;
  }
  const i = v.indexOf('|');
  if (i < 0) return;
  const prov = v.slice(0, i);
  const mid = v.slice(i + 1);
  if (!PROVIDERS[prov] || !mid) return;
  cfg = await api.setConfig({ provider: prov, models: { ...(cfg.models || {}), [prov]: mid } });
});

/* ------------------------------ attachments ------------------------------ */

const TEXT_EXT = /\.(txt|md|markdown|json|js|jsx|ts|tsx|css|html|htm|xml|yml|yaml|csv|log|py|java|c|cpp|h|cs|php|rb|go|rs|sh|bat|ps1|ini|cfg|conf|env|sql|toml)$/i;

function isImageFile(f) {
  return f.type && f.type.startsWith('image/');
}

function renderAttachments() {
  if (!attachments.length) {
    attachTray.classList.add('hidden');
    attachTray.innerHTML = '';
    return;
  }
  attachTray.classList.remove('hidden');
  attachTray.innerHTML = '';
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    if (a.kind === 'image') {
      chip.innerHTML = '<img src="' + a.dataUrl + '" alt="" /><span class="a-name">' + esc(a.name) + '</span><button class="a-x" title="Remove">✕</button>';
    } else {
      chip.innerHTML = '<span class="a-icon">📄</span><span class="a-name" title="' + esc(a.name) + '">' + esc(a.name) + '</span><button class="a-x" title="Remove">✕</button>';
    }
    chip.querySelector('.a-x').addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachments();
    });
    attachTray.appendChild(chip);
  });
}

// Downscale big images so they don't blow up the request.
function processImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1568;
      const sizeOk = dataUrl.length < 1200000;
      const dimOk = Math.max(img.width, img.height) <= MAX;
      if (sizeOk && dimOk) return resolve(dataUrl);
      const scale = Math.min(MAX / img.width, MAX / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function addImageFile(file) {
  const images = attachments.filter((a) => a.kind === 'image').length;
  if (images >= 4) return showNotice('Max 4 images per message.', false);
  if (file.size > 15000000) return showNotice('Image too large (max 15 MB).', false);
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const processed = await processImage(dataUrl);
  attachments.push({ kind: 'image', dataUrl: processed, name: file.name || 'image.png' });
  renderAttachments();
}

async function addTextFile(file) {
  if (file.size > 1500000) return showNotice('Text file too large (max 1.5 MB).', false);
  const text = await file.text();
  if (!text.trim()) return showNotice('That file looks empty.', false);
  attachments.push({ kind: 'text', name: file.name, content: text.slice(0, 60000) });
  renderAttachments();
}

async function handleFiles(files) {
  for (const f of Array.from(files || [])) {
    try {
      if (isImageFile(f)) await addImageFile(f);
      else if (f.type.startsWith('text/') || TEXT_EXT.test(f.name) || f.type === 'application/json') await addTextFile(f);
      else showNotice('Unsupported file: ' + f.name + ' — images and text/code files work.', false);
    } catch (e) {
      showNotice('Could not read ' + (f.name || 'file'), false);
    }
  }
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
  fileInput.value = '';
});

shotBtn.addEventListener('click', async () => {
  shotBtn.disabled = true;
  try {
    const r = await api.captureScreen();
    if (r.ok) {
      const processed = await processImage(r.dataUrl);
      attachments.push({ kind: 'image', dataUrl: processed, name: 'screenshot.png' });
      renderAttachments();
      inputEl.focus();
    } else {
      showNotice('Screenshot failed: ' + r.error, false);
    }
  } finally {
    shotBtn.disabled = false;
  }
});

// Paste screenshots/images straight into the chat (e.g. Win+Shift+S then Ctrl+V)
document.addEventListener('paste', (e) => {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const imgItem = items.find((i) => i.type && i.type.startsWith('image/'));
  if (imgItem) {
    e.preventDefault();
    const f = imgItem.getAsFile();
    if (f) addImageFile(f);
  }
});

// Drag & drop files onto the chat
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});

/* ---------------------------------- skills --------------------------------- */

function renderSkills() {
  if (!cfg.showSkills || !cfg.skills || !cfg.skills.length) {
    skillsEl.classList.add('hidden');
    return;
  }
  skillsEl.classList.remove('hidden');
  skillsEl.innerHTML = '';
  for (const s of cfg.skills) {
    const chip = document.createElement('button');
    chip.className = 'skill-chip';
    chip.textContent = s.name;
    chip.title = s.prompt;
    chip.onclick = () => {
      inputEl.value = s.prompt;
      inputEl.focus();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      inputEl.scrollTop = inputEl.scrollHeight;
    };
    skillsEl.appendChild(chip);
  }
}

/* ---------------------------------- events --------------------------------- */

sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', () => { resetStreamTts(true); api.stopChat(); });
async function refreshChatList() {
  const chats = await api.chats.list();
  historyPanel.innerHTML = '<h4>Recent chats</h4>';
  if (!chats.length) {
    historyPanel.innerHTML += '<div class="history-empty">No chats yet</div>';
    return;
  }
  for (const c of chats) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const title = document.createElement('span');
    title.className = 'h-title';
    title.textContent = c.title || 'Untitled';
    title.title = c.title;
    const del = document.createElement('button');
    del.className = 'h-del';
    del.title = 'Delete chat';
    del.textContent = '✕';
    item.appendChild(title);
    item.appendChild(del);
    item.addEventListener('click', async () => {
      historyPanel.classList.add('hidden');
      const opened = await api.chats.open(c.id);
      messages = opened.messages || [];
      renderHistory();
      highlightActive();
    });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.chats.remove(c.id);
      if ((await api.chats.list()).every((x) => x.id !== c.id && true) && messages.length && c.id === currentChatId()) {
        // active chat was deleted → clear view
        messages = [];
        renderHistory();
      }
      refreshChatList();
    });
    historyPanel.appendChild(item);
  }
  highlightActive();
}

function currentChatId() {
  // best-effort: main tracks activeChatId; we approximate by last opened
  return currentChatId._id || null;
}

function highlightActive() {
  historyPanel.querySelectorAll('.history-item').forEach((el, i) => {
    el.classList.remove('active');
  });
}

newChatBtn.addEventListener('click', async () => {
  await api.chats.create();
  messages = [];
  renderHistory();
  refreshChatList();
  inputEl.focus();
});

historyBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  historyPanel.classList.toggle('hidden');
  if (!historyPanel.classList.contains('hidden')) refreshChatList();
});
document.addEventListener('click', (e) => {
  if (!historyPanel.classList.contains('hidden') && !historyPanel.contains(e.target) && e.target !== historyBtn) {
    historyPanel.classList.add('hidden');
  }
});

// track active chat id via opens
const _origOpen = api.chats.open;
api.chats.open = async (id) => {
  currentChatId._id = id;
  return _origOpen(id);
};
settingsBtn.addEventListener('click', () => api.openMain());
closeBtn.addEventListener('click', () => window.close());

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});


/* ------------------------------ mic recording ------------------------------ */

let mediaRec = null;
let recStream = null;
let recChunks = [];
let recTimer = null;

async function toggleRecording() {
  if (mediaRec && mediaRec.state === 'recording') {
    mediaRec.stop();
    return;
  }
  // Pre-flight: voice needs a (free) Groq key. Tell the user BEFORE recording.
  if (!(((cfg.keys || {}).groq || '').trim())) {
    showNotice('🎙 Voice needs a FREE Groq key (console.groq.com/keys) — opened the Connection tab for you. Paste it, click Test, then try the mic again.', true);
    api.openMain();
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showNotice('Microphone blocked — allow mic access for Orbit AI and try again.', false);
    return;
  }
  recChunks = [];
  try {
    mediaRec = new MediaRecorder(recStream, { mimeType: 'audio/webm' });
  } catch {
    mediaRec = new MediaRecorder(recStream);
  }
  mediaRec.ondataavailable = (e) => {
    if (e.data && e.data.size) recChunks.push(e.data);
  };
  mediaRec.onstop = async () => {
    try {
      if (recStream) recStream.getTracks().forEach((t) => t.stop());
    } catch {}
    clearTimeout(recTimer);
    micBtn.classList.remove('recording');
    const blob = new Blob(recChunks, { type: 'audio/webm' });
    mediaRec = null;
    if (blob.size < 2000) return; // too short / accidental click
    micBtn.disabled = true;
    showNotice('Transcribing your voice…', false);
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const r = await api.transcribe(buf, (cfg || {}).voiceSettings ? cfg.voiceSettings.callLang : undefined);
      if (r && r.ok && r.text) {
        inputEl.value = (inputEl.value ? inputEl.value + ' ' : '') + r.text.trim();
        inputEl.focus();
        if (!cfg.voiceSettings || cfg.voiceSettings.sttAutoSend !== false) send();
      } else if (r && r.error) {
        showNotice('Voice input: ' + r.error, false);
      }
    } catch (e) {
      showNotice('Voice input failed: ' + (e.message || e), false);
    } finally {
      micBtn.disabled = false; // never leave the mic stuck
    }
  };
  mediaRec.start();
  micBtn.classList.add('recording');
  recTimer = setTimeout(() => {
    if (mediaRec && mediaRec.state === 'recording') mediaRec.stop();
  }, 60000);
}

micBtn.addEventListener('click', toggleRecording);
readLastBtn.addEventListener('click', () => {
  const t = lastAssistantText();
  if (t) speak(t);
});
speakStopBtn.addEventListener('click', async () => {
  await api.ttsStop();
  hideSpeakBar();
});

/* --------------------------------- call mode ------------------------------- */

const call = {
  active: false, stream: null, ctx: null, analyser: null, data: null,
  recorder: null, chunks: [], processing: false, ttsActive: false,
  approvalPending: false,
  lastVoiceTime: 0, segmentStart: 0, loopTimer: null, levelCtx: null
};

const CALL_SILENCE_MS = 1400;   // pause length that ends your sentence
// Mic pickup distance: how loud (and thus how CLOSE) a voice must be to count.
// "near" ≈ 1 meter or less — far voices / TV / room chatter stay below the gate.
const MIC_PICKUP_LEVELS = { near: 0.075, normal: 0.05, room: 0.032 };
const CALL_MAX_SEGMENT_MS = 25000;

async function startCall() {
  if (call.active) return endCall();
  if (!((((cfg || {}).keys || {}).groq || '').trim())) {
    showNotice('📞 Call mode needs a FREE Groq key (console.groq.com/keys) — opened the Connection tab for you.', true);
    api.openMain();
    return;
  }
  try {
    call.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    showNotice('Microphone blocked — allow mic access for Orbit AI and try again.', false);
    return;
  }
  call.active = true;
  call.startLevel = MIC_PICKUP_LEVELS[((cfg || {}).voiceSettings || {}).micPickup] || MIC_PICKUP_LEVELS.near;
  try {
    call.ctx = new AudioContext();
    const src = call.ctx.createMediaStreamSource(call.stream);
    call.analyser = call.ctx.createAnalyser();
    call.analyser.fftSize = 512;
    src.connect(call.analyser);
    call.data = new Uint8Array(call.analyser.fftSize);
  } catch (e) {
    endCall();
    showNotice('Audio init failed: ' + (e.message || e), false);
    return;
  }
  callBtn.classList.add('on-call');
  callBar.classList.remove('hidden');
  callStateEl.textContent = 'Listening… just talk';
  call.levelCtx = callLevelCv.getContext('2d');
  callLoop();
}

function endCall() {
  call.active = false;
  call.approvalPending = false;
  call.hush = false;
  call.bargeCount = 0;
  disarmCallWatchdog();
  hideTyping();
  resetStreamTts(true);
  if (call.loopTimer) clearTimeout(call.loopTimer);
  if (call.recorder && call.recorder.state === 'recording') {
    try { call.recorder.onstop = null; call.recorder.stop(); } catch {}
  }
  call.recorder = null;
  call.processing = false;
  call.ttsActive = false;
  try { if (call.stream) call.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (call.ctx) call.ctx.close(); } catch {}
  call.stream = null;
  call.ctx = null;
  callBtn.classList.remove('on-call');
  callBar.classList.add('hidden');
}

function callLevel() {
  call.analyser.getByteTimeDomainData(call.data);
  let sum = 0;
  for (let i = 0; i < call.data.length; i++) {
    const v = (call.data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / call.data.length); // RMS 0..1
}

function drawLevel(level) {
  if (!call.levelCtx) return;
  const { width: w, height: h } = callLevelCv;
  call.levelCtx.clearRect(0, 0, w, h);
  call.levelCtx.fillStyle = 'rgba(52, 211, 153, .25)';
  call.levelCtx.fillRect(0, 0, w, h);
  const bh = Math.max(2, Math.min(1, level * 6) * h);
  call.levelCtx.fillStyle = '#34d399';
  call.levelCtx.fillRect(0, (h - bh) / 2, w, bh);
}

// Barge-in: while Orbit talks, keep an ear out — a LOUD sustained voice (comfortably
// above his own echo) cuts his speech instantly, like interrupting a real person.
const BARGE_IN_TICKS = 3; // consecutive loud loop ticks (~270ms)

function bargeLevel() {
  return Math.max(0.085, (call.startLevel || 0.045) * 1.7);
}

function bargeIn() {
  call.bargeCount = 0;
  call.hush = true;          // don't re-speak the interrupted reply when the turn ends
  resetStreamTts(true);      // kill the queue + current audio NOW
  call.ttsActive = false;
  hideSpeakBar();
  api.stopChat();            // abort the in-flight turn — the user is taking over
  callStateEl.textContent = '✋ interrupted — go ahead';
}

function callLoop() {
  if (!call.active) return;
  const level = callLevel();
  drawLevel(level);
  const now = Date.now();
  const speech = level > call.startLevel;
  const micFree = !call.processing && !call.ttsActive && !call.approvalPending;

  // --- barge-in watch (runs even while he is speaking) ---
  if (call.ttsActive && !call.approvalPending) {
    if (level > bargeLevel()) {
      call.bargeCount = (call.bargeCount || 0) + 1;
      if (call.bargeCount >= BARGE_IN_TICKS) bargeIn();
    } else {
      call.bargeCount = 0;
    }
  } else {
    call.bargeCount = 0;
  }

  if (call.recorder && call.recorder.state === 'recording') {
    if (speech) call.lastVoiceTime = now;
    const silence = now - call.lastVoiceTime > CALL_SILENCE_MS;
    const tooLong = now - call.segmentStart > CALL_MAX_SEGMENT_MS;
    if ((silence || tooLong) && micFree) {
      finishSegment();
    }
  } else if (speech && micFree) {
    startSegment();
    call.lastVoiceTime = now;
  }

  call.loopTimer = setTimeout(callLoop, 90);
}

function startSegment() {
  call.chunks = [];
  try {
    call.recorder = new MediaRecorder(call.stream, { mimeType: 'audio/webm' });
  } catch {
    call.recorder = new MediaRecorder(call.stream);
  }
  call.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) call.chunks.push(e.data);
  };
  call.recorder.start();
  call.segmentStart = Date.now();
  callStateEl.textContent = '🎙 recording…';
}

function finishSegment() {
  const rec = call.recorder;
  call.recorder = null;
  if (!rec) return;
  rec.onstop = async () => {
    const blob = new Blob(call.chunks, { type: 'audio/webm' });
    call.chunks = [];
    if (blob.size < 3000) return; // noise blip
    call.processing = true;
    callStateEl.textContent = 'Transcribing…';
    let text = '';
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const r = await api.transcribe(buf, (cfg || {}).voiceSettings ? cfg.voiceSettings.callLang : undefined);
      if (r && r.ok && r.text) text = r.text.trim();
      else if (r && r.error) {
        showNotice('Call: ' + r.error, false);
        callStateEl.textContent = 'Mic error — retrying';
      }
    } catch (e) {
      showNotice('Call transcription failed: ' + (e.message || e), false);
    }
    if (text && call.active) {
      // send() shows the typing dots itself and resolves when the turn ends.
      // NOTE: nothing may be shown after it — a stray showTyping() here used to
      // paint eternal dots AFTER the reply finished.
      const sent = await send(text, { fromCall: true });
      if (!sent && call.active) {
        // turn never started (busy/streaming) → don't leave the call deaf
        call.processing = false;
        callStateEl.textContent = 'Listening… just talk';
      }
    } else if (call.active) {
      call.processing = false;
      callStateEl.textContent = 'Listening… just talk';
    }
  };
  try { rec.stop(); } catch {}
}

callBtn.addEventListener('click', startCall);
callEndBtn.addEventListener('click', endCall);
window.addEventListener('beforeunload', endCall);

/* ----------------------------------- boot ---------------------------------- */

const PROVIDERS = {
  groq: { id: 'groq', label: 'Groq' },
  openrouter: { id: 'openrouter', label: 'OpenRouter' },
  nvidia: { id: 'nvidia', label: 'NVIDIA' },
  local: { id: 'local', label: 'Local' }
};

(async function boot() {
  cfg = await api.getConfig();
  messages = (await api.getHistory()) || [];
  setStreaming(false); // make sure send/stop buttons start in a sane state
  renderHistory();
  refreshChatList();
  renderSkills();
  await fillModelSelect();
  loadAllProviderModels().then(fillModelSelect);
  api.on('agent:event', onAgentEvent);
  api.on('mcp:changed', () => {});
  api.on('chats:changed', () => refreshChatList());
  api.on('config:changed', (d) => {
    const keysFixed = JSON.stringify(d.keys || {}) !== JSON.stringify((cfg || {}).keys || {});
    cfg = d;
    fillModelSelect();
    if (keysFixed) clearNotice(); // user fixed the key problem → old error disappears
  });
  inputEl.focus();
})();
