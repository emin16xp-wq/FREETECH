/* Quick-capture popup logic: chips + custom ask, streaming result. */
const $ = (id) => document.getElementById(id);
const resultEl = $('result');
const askEl = $('ask');
const stateEl = $('stateHint');
const copyBtn = $('copyBtn');

let selText = '';
let busy = false;

(async function boot() {
  const init = await quickApi.init();
  selText = init.text || '';
  showSelection();
  buildChips(init.arabic === true);
  askEl.focus();
})();

function showSelection() {
  const el = $('selText');
  el.textContent = selText ? selText.slice(0, 600) : 'No text selected — type a question below, or press "Select again" and select text in any app first.';
  el.style.display = selText ? 'block' : 'none';
}

function buildChips(arabic) {
  const chipsEl = $('chips');
  chipsEl.innerHTML = '';
  const actions = [
    ['Summarize', 'Summarize this in a few short bullet points.'],
    ['Explain simply', 'Explain this in simple, plain words.'],
    ['Fix grammar', 'Fix the grammar and spelling. Reply with ONLY the corrected text, nothing else.'],
    [arabic ? 'Translate → English' : 'Translate → العربية', arabic ? 'Translate this to English. Reply with ONLY the translation.' : 'Translate this to Arabic. Reply with ONLY the translation.']
  ];
  for (const [label, instruction] of actions) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.addEventListener('click', () => run(instruction));
    chipsEl.appendChild(b);
  }
}

async function run(instruction) {
  if (busy) return;
  busy = true;
  copyBtn.classList.remove('glow');
  resultEl.innerHTML = '';
  stateEl.textContent = 'Thinking…';
  const r = await quickApi.ask(instruction);
  busy = false;
  if (r && r.ok === false) {
    stateEl.textContent = '';
    resultEl.innerHTML = '<div class="placeholder">⚠ ' + escapeHtml(r.error || 'Something went wrong.') + '</div>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let streamBuf = '';
quickApi.onEvent((ev) => {
  if (ev.type === 'delta') {
    streamBuf += ev.text || '';
    resultEl.textContent = streamBuf;
    resultEl.scrollTop = resultEl.scrollHeight;
    copyBtn.classList.add('glow');
  } else if (ev.type === 'done') {
    if (ev.text && !streamBuf) resultEl.textContent = ev.text; // non-streaming fallback
    stateEl.textContent = '';
    busy = false;
  } else if (ev.type === 'error') {
    stateEl.textContent = '';
    resultEl.innerHTML = '<div class="placeholder">⚠ ' + escapeHtml(ev.message || 'Failed.') + '</div>';
    busy = false;
  }
});

askEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const q = askEl.value.trim();
    if (!q) return;
    askEl.value = '';
    run(q);
  }
});

copyBtn.addEventListener('click', async () => {
  if (!streamBuf && !resultEl.textContent) return;
  await quickApi.copy(streamBuf || resultEl.textContent);
  copyBtn.textContent = '✓ Copied';
  setTimeout(() => (copyBtn.textContent = '⧉ Copy'), 1200);
});

$('againBtn').addEventListener('click', async () => {
  const r = await quickApi.recapture();
  if (r && r.text) {
    selText = r.text;
    showSelection();
    buildChips(r.arabic === true);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') quickApi.close();
});
$('closeBtn').addEventListener('click', () => quickApi.close());
