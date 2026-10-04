/* Model picker window logic */
const $ = (id) => document.getElementById(id);
const searchEl = $('search');
const listEl = $('list');
const chipsEl = $('chips');

const PROVIDER_META = {
  groq: { label: 'Groq', needsKey: true },
  openrouter: { label: 'OpenRouter', needsKey: true },
  nvidia: { label: 'NVIDIA', needsKey: true },
  local: { label: 'Local AI', needsKey: false }
};

let cfg = null;
let models = {};            // providerId -> [{id, label, vision, free}]
let providerFilter = 'all'; // 'all' | providerId
let freeOnly = false;
let query = '';
let hlIndex = 0;            // highlighted item for keyboard nav

(async function boot() {
  cfg = await pickerApi.init();
  renderChips();
  listEl.innerHTML = '<div class="empty">Loading models from all providers…</div>';
  await Promise.all(Object.keys(PROVIDER_META).map(async (id) => {
    try {
      models[id] = await pickerApi.listModels(id);
    } catch {
      models[id] = [];
    }
  }));
  render();
  searchEl.focus();
})();

function renderChips() {
  chipsEl.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'chip' + (providerFilter === 'all' ? ' on' : '');
  all.textContent = 'All';
  all.onclick = () => { providerFilter = 'all'; renderChips(); render(); };
  chipsEl.appendChild(all);
  for (const [id, meta] of Object.entries(PROVIDER_META)) {
    const b = document.createElement('button');
    b.className = 'chip' + (providerFilter === id ? ' on' : '');
    const hasKey = id === 'local' || ((cfg.keys || {})[id] || '').trim();
    b.textContent = meta.label + (hasKey ? '' : ' 🔒');
    b.title = hasKey ? '' : 'No API key set yet';
    b.onclick = () => { providerFilter = id; renderChips(); render(); };
    chipsEl.appendChild(b);
  }
  const f = document.createElement('button');
  f.className = 'chip' + (freeOnly ? ' on' : '');
  f.textContent = '🆓 Free only';
  f.onclick = () => { freeOnly = !freeOnly; renderChips(); render(); };
  chipsEl.appendChild(f);
}

function matches(m) {
  if (freeOnly && !m.free) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q);
}

function render() {
  listEl.innerHTML = '';
  hlIndex = 0;
  let shown = 0;
  let first = true;

  for (const [id, meta] of Object.entries(PROVIDER_META)) {
    if (providerFilter !== 'all' && providerFilter !== id) continue;
    const list = (models[id] || []).filter(matches);
    if (!list.length) continue;

    const g = document.createElement('div');
    g.className = 'group';
    g.textContent = meta.label + (models[id].length ? ` (${list.length})` : '');
    listEl.appendChild(g);

    if (!models[id].length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = id === 'local'
        ? 'Local server not reachable — start it in Hermes/Ollama first.'
        : '🔒 No API key — add one in Orbit → Connection';
      listEl.appendChild(e);
      continue;
    }

    for (const m of list.slice(0, 400)) {
      shown++;
      const item = document.createElement('div');
      item.className = 'item';
      const isCurrent = cfg.provider === id && (cfg.models || {})[id] === m.id;
      if (isCurrent) item.classList.add('current');
      if (first) { item.classList.add('hl'); first = false; }
      item.dataset.provider = id;
      item.dataset.model = m.id;

      const name = document.createElement('span');
      name.className = 'id';
      name.textContent = m.id;
      item.appendChild(name);

      if (m.free) {
        const t = document.createElement('span');
        t.className = 'tag free';
        t.textContent = 'FREE';
        item.appendChild(t);
      }
      if (m.vision) {
        const t = document.createElement('span');
        t.className = 'tag vision';
        t.textContent = '👁 VISION';
        item.appendChild(t);
      }
      if (isCurrent) {
        const t = document.createElement('span');
        t.className = 'tag cur';
        t.textContent = '✓ current';
        item.appendChild(t);
      }

      item.addEventListener('click', () => pick(id, m.id));
      listEl.appendChild(item);
    }
  }

  if (!shown) {
    listEl.innerHTML = '<div class="empty">No models match your search.<br/>Try fewer words, or clear the Free filter.</div>';
  }
}

async function pick(provider, modelId) {
  await pickerApi.setModel(provider, modelId);
  pickerApi.close();
}

searchEl.addEventListener('input', () => {
  query = searchEl.value.trim();
  render();
});

document.addEventListener('keydown', (e) => {
  const items = [...listEl.querySelectorAll('.item')];
  if (e.key === 'Escape') {
    pickerApi.close();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    items[hlIndex] && items[hlIndex].classList.remove('hl');
    hlIndex = (hlIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[hlIndex].classList.add('hl');
    items[hlIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const it = items[hlIndex] || items[0];
    if (it) pick(it.dataset.provider, it.dataset.model);
  }
});

$('closeBtn').addEventListener('click', () => pickerApi.close());
