// AI providers — Groq, OpenRouter and NVIDIA NIM.
// All three expose OpenAI-compatible APIs, so one client handles them all.

const PROVIDERS = {
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    keyUrl: 'https://console.groq.com/keys',
    hint: 'Extremely fast inference. Free tier available.'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    keyUrl: 'https://openrouter.ai/keys',
    hint: '400+ models: GPT, Claude, Gemini, Llama, DeepSeek…'
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    hint: 'NVIDIA-hosted open models (Llama, DeepSeek, Nemotron…).'
  },
  local: {
    id: 'local',
    label: 'Local (Hermes / llama.cpp / Ollama…)',
    baseUrl: '', // user-configured — see localBaseUrl in the config store
    modelsUrl: '',
    keyUrl: '',
    hint: 'AI running on this PC. Hermes Desktop local models → http://localhost:8080/v1'
  }
};

// Well-known local OpenAI-compatible endpoints (shown as one-click presets).
const LOCAL_PRESETS = [
  { label: 'Hermes local models (llama.cpp)', url: 'http://localhost:8080/v1' },
  { label: 'Hermes Agent gateway', url: 'http://localhost:8642/v1' },
  { label: 'Ollama', url: 'http://localhost:11434/v1' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1' }
];

// Fallbacks used if the /models request fails (e.g. no key yet).
const DEFAULT_MODELS = {
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'moonshotai/kimi-k2-instruct',
    'qwen/qwen3-32b',
    'deepseek-r1-distill-llama-70b'
  ],
  openrouter: [
    'openai/gpt-4o-mini',
    'anthropic/claude-3.5-sonnet',
    'google/gemini-2.0-flash-001',
    'deepseek/deepseek-chat',
    'meta-llama/llama-3.3-70b-instruct',
    'mistralai/mistral-large',
    'x-ai/grok-2-1212'
  ],
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'nvidia/llama-3.1-nemotron-70b-instruct',
    'deepseek-ai/deepseek-r1',
    'qwen/qwen2.5-coder-32b-instruct',
    'mistralai/mixtral-8x22b-instruct-v0.1'
  ]
};

function fallbackModels(provider) {
  return (DEFAULT_MODELS[provider] || []).map((id) => ({ id, label: id }));
}

// Resolve the API base for a provider (local = user-configured Base URL).
function resolveBase(provider, baseUrlOverride) {
  if (provider === 'local') {
    return String(baseUrlOverride || '').trim().replace(/\/+$/, '');
  }
  return PROVIDERS[provider].baseUrl;
}

// Small, cheap models used for the real "is this key working" test message.
const PING_MODEL = {
  groq: 'llama-3.1-8b-instant',
  openrouter: 'openai/gpt-4o-mini',
  nvidia: 'meta/llama-3.3-70b-instruct'
};

/**
 * REAL key verification — not just a model-list fetch (OpenRouter's model list
 * is public, so that would "work" even with a wrong key). We actually send a
 * tiny chat completion and only report success when the provider answers.
 * For the `local` provider this verifies the server itself is reachable and
 * generating (no API key required).
 */
async function testKeyReal(provider, apiKey, preferredModel, baseUrlOverride) {
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, error: 'Unknown provider' };
  if (!apiKey && provider !== 'local') return { ok: false, error: 'No key entered' };
  const base = resolveBase(provider, baseUrlOverride);
  if (provider === 'local' && !base) {
    return { ok: false, error: 'No Base URL set. Try the Hermes preset: http://localhost:8080/v1' };
  }

  // Step 1 — auth/reachability check against /models.
  try {
    const r = await fetch(base + '/models', {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(provider === 'local' ? 6000 : 15000)
    });
    if (r.status === 401 || r.status === 403) {
      if (provider === 'local') return { ok: false, error: 'The server rejected us (auth) — if it requires a key, paste it in the key field.' };
      return { ok: false, error: `Invalid key — ${p.label} rejected it (auth failed). Double-check you copied the whole key.` };
    }
  } catch (e) {
    if (provider === 'local') {
      return { ok: false, error: `Can't reach ${base} — is the local server running? (Hermes: Settings → Providers → Local Models → start it.)` };
    }
    return { ok: false, error: `Could not reach ${p.label} (${e.message || e}). Check your internet/VPN.` };
  }

  // Step 2 — a real (tiny) completion. For local with no model set, auto-pick
  // the first model the server offers.
  const candidates = [];
  if (preferredModel) candidates.push(preferredModel);
  if (provider === 'local' && !candidates.length) {
    try {
      const r = await fetch(base + '/models', { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        const first = (j.data || j.models || [])[0];
        if (first) candidates.push(typeof first === 'string' ? first : first.id);
      }
    } catch {}
  }
  const fb = PING_MODEL[provider];
  if (fb && !candidates.includes(fb)) candidates.push(fb);
  if (!candidates.length) return { ok: false, error: 'No model available on this server.' };

  let lastErr = '';
  for (const model of candidates) {
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(provider === 'openrouter'
            ? { 'HTTP-Referer': 'https://orbit-ai.desktop', 'X-Title': 'Orbit AI' }
            : {})
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
          max_tokens: 300,
          stream: false,
          temperature: 0
        }),
        signal: AbortSignal.timeout(provider === 'local' ? 120000 : 30000)
      });
      if (res.ok) {
        let reply = '';
        try {
          const j = await res.json();
          reply = String(j.choices?.[0]?.message?.content || '').trim().slice(0, 60);
        } catch {}
        return { ok: true, modelUsed: model, reply };
      }
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'Invalid key — the provider rejected it (auth failed).' };
      }
      if (res.status === 429) {
        // Auth was fine; rate-limited (e.g. free tier quota).
        return { ok: false, error: `Key is valid but rate-limited (429). ${text.slice(0, 140)}`, rateLimited: true };
      }
      lastErr = `model ${model}: HTTP ${res.status} ${text.slice(0, 160)}`;
    } catch (e) {
      lastErr = `model ${model}: ${e.message || e}`;
    }
  }
  return { ok: false, error: `Key looks accepted, but the test message failed — ${lastErr}` };
}

async function listModels(provider, apiKey, baseUrlOverride) {
  const p = PROVIDERS[provider];
  if (!p) return [];
  const base = resolveBase(provider, baseUrlOverride);
  if (!base) return []; // local provider with no Base URL configured yet
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(base + '/models', {
      headers,
      signal: AbortSignal.timeout(provider === 'local' ? 6000 : 15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    let models = (json.data || json.models || [])
      .map((m) => (typeof m === 'string' ? { id: m } : m))
      .map((m) => ({
        id: m.id,
        label: m.name || m.display_name || m.id,
        // OpenRouter marks non-text models; keep text-capable ones on top
        text: m.architecture ? String(m.architecture.modality || '').includes('->text') : true,
        // Can this model see images? (available on OpenRouter metadata)
        vision: !!(m.architecture && Array.isArray(m.architecture.input_modalities) && m.architecture.input_modalities.includes('image')),
        // Free models (OpenRouter ':free' suffix or zero-priced)
        free: /:free$/i.test(String(m.id)) || !!(m.pricing && String(m.pricing.prompt) === '0' && String(m.pricing.completion) === '0')
      }))
      .filter((m) => m.id);
    models.sort((a, b) => {
      if (a.free !== b.free) return a.free ? -1 : 1; // free models first
      return a.text === b.text ? a.label.localeCompare(b.label) : a.text ? -1 : 1;
    });
    if (!models.length) throw new Error('empty model list');
    return models;
  } catch {
    if (provider === 'local') return []; // UI shows "server not reachable" message
    return fallbackModels(provider);
  }
}

/**
 * Streaming chat completion (OpenAI-compatible SSE).
 * Returns { content, toolCalls } after the stream ends.
 * onDelta(textChunk) is called for content tokens.
 */
async function streamChat({ provider, apiKey, model, messages, tools, temperature = 0.7, signal, onDelta, baseUrl }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider: ${provider}`);
  const base = resolveBase(provider, baseUrl);
  if (!base) throw new Error('No Base URL set for the local server. Orbit AI → Connection → Local → set it (e.g. http://localhost:8080/v1).');
  if (!apiKey && provider !== 'local') throw new Error(`No API key set for ${p.label}. Open Orbit AI settings to add one.`);

  const body = { model, messages, stream: true, temperature };
  if (tools && tools.length) body.tools = tools;

  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://orbit-ai.desktop';
    headers['X-Title'] = 'Orbit AI';
  }

  // Hard ceiling so a hanging server can never stall the UI forever
  // (local models get longer — they can load big weights on first call).
  const timeoutMs = provider === 'local' ? 600000 : 180000;
  let timedSignal = signal;
  try {
    const t = AbortSignal.timeout(timeoutMs);
    timedSignal = signal ? AbortSignal.any([signal, t]) : t;
  } catch {
    /* older runtime without any()/timeout() — just use the user's signal */
  }

  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: timedSignal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `API error ${res.status}`;
    try {
      const j = JSON.parse(text);
      msg += `: ${j.error?.message || j.detail || text.slice(0, 300)}`;
    } catch {
      if (text) msg += `: ${text.slice(0, 300)}`;
    }
    const err = new Error(msg);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls = [];

  const handleEvent = (json) => {
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', arguments: '' };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function && tc.function.name) toolCalls[i].name += tc.function.name;
        if (tc.function && tc.function.arguments) toolCalls[i].arguments += tc.function.arguments;
      }
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        handleEvent(JSON.parse(data));
      } catch {
        /* skip malformed chunk */
      }
    }
  }

  return {
    content,
    toolCalls: toolCalls
      .filter(Boolean)
      .filter((t) => t.name)
      .map((t) => ({
        id: t.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: t.name, arguments: t.arguments || '{}' }
      }))
  };
}

// Heuristic: did the provider reject the request because the model can't do tools?
function isToolUnsupportedError(err) {
  if (!err) return false;
  if (err.status !== 400 && err.status !== 404 && err.status !== 422) return false;
  return /tool|function/i.test(String(err.message || ''));
}

/**
 * Speech-to-text via Groq Whisper (works with the free Groq tier).
 * audioBytes: Uint8Array of a webm/wav recording. Returns {ok, text} or {ok:false, error}.
 */
// Groq online TTS (Orpheus by Canopy Labs — replaced PlayAI in 2026).
// Internet voices, including real Arabic ones. Uses the same (free) Groq key as STT.
const GROQ_TTS = {
  arabic: { model: 'canopylabs/orpheus-arabic-saudi', voices: ['noura', 'fahad', 'sultan', 'lulwa', 'abdullah', 'aisha'], def: 'noura' },
  english: { model: 'canopylabs/orpheus-v1-english', voices: ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'], def: 'autumn' }
};

async function speakGroqTts(apiKey, { text, voice }) {
  if (!apiKey) return { ok: false, error: 'Online voices need a (free) Groq API key — console.groq.com/keys' };
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: 'Nothing to speak.' };
  const arabic = /[\u0600-\u06FF]/.test(clean);
  const conf = arabic ? GROQ_TTS.arabic : GROQ_TTS.english;
  const want = String(voice || '').toLowerCase().trim();
  const chosen = conf.voices.includes(want) ? want : conf.def;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: conf.model, voice: chosen, input: clean.slice(0, 900), response_format: 'wav' }),
      signal: AbortSignal.timeout(30000)
    });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'Invalid Groq key for online voices.' };
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `Groq TTS failed (HTTP ${r.status}). ${t.slice(0, 140)}` };
    }
    return { ok: true, wav: Buffer.from(await r.arrayBuffer()), voiceUsed: chosen, arabic };
  } catch (e) {
    return { ok: false, error: 'Could not reach Groq TTS: ' + (e.message || e) };
  }
}

async function transcribeGroqAudio(apiKey, audioBytes, baseUrl = 'https://api.groq.com/openai/v1', language) {
  if (!apiKey) {
    return { ok: false, error: 'Voice input needs a (free) Groq API key — console.groq.com/keys' };
  }
  try {
    const form = new FormData();
    form.append('file', new Blob([audioBytes], { type: 'audio/webm' }), 'speech.webm');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    if (language) form.append('language', String(language)); // force 'en' or 'ar' transcription
    const r = await fetch(baseUrl + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60000)
    });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'Invalid Groq key.' };
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, error: `Transcription failed (HTTP ${r.status}). ${t.slice(0, 120)}` };
    }
    const j = await r.json();
    return { ok: true, text: String(j.text || '').trim() };
  } catch (e) {
    return { ok: false, error: 'Could not reach Groq: ' + (e.message || e) };
  }
}

module.exports = { PROVIDERS, DEFAULT_MODELS, LOCAL_PRESETS, listModels, streamChat, isToolUnsupportedError, testKeyReal, transcribeGroqAudio, speakGroqTts, GROQ_TTS };
