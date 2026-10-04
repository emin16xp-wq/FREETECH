// Text-to-speech using Windows' built-in voices via PowerShell. Zero deps, offline.
// TWO engines, chosen per utterance:
//   • winrt  — Windows.Media.SpeechSynthesis (modern voices from Settings → Speech,
//              including Natural voices; the ONLY pool that sees newly installed
//              Arabic language voices on Windows 11)
//   • sapi   — System.Speech (classic Desktop voices like Microsoft Hoda Desktop)
// Arabic: with no explicit voice picked, Arabic text auto-selects an Arabic voice
// (winrt by Language ar-*, sapi by name). If none exists the caller gets a
// warn:'no-arabic-voice' so the UI can show install instructions.
// One utterance at a time — a new speak() cancels the previous one.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*ISAR-START*/
function isArabicText(t) {
  return /[\u0600-\u06FF]/.test(String(t || ''));
}
/*ISAR-END*/

// PowerShell helper (shared by both engine scripts): await an IAsyncOperation
// from PS 5.1 via the AsTask reflection trick. NOTE: PS generic type names embed
// the PowerShell escape char (IAsyncOperation + backtick + 1) — never paste that
// char into this file: wildcard-match 'IAsyncOperation*' instead.
const AS_TASK =
  '$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | ' +
  "Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } | " +
  'Select-Object -First 1;';

// --- SAPI engine (System.Speech) — classic desktop voices ---
const SPEAK_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  'Add-Type -AssemblyName System.Speech;' +
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
  'if($env:ORBIT_VOICE){ try { $s.SelectVoice($env:ORBIT_VOICE); } catch {} };' +
  "$warned = $false;" +
  "if($env:ORBIT_AUTOAR -eq '1'){ $av = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -match '(?i)arabic|hoda|naayf|asma|hamed|laila|taim|saleem' } | Select-Object -First 1; if($av){ try { $s.SelectVoice($av.VoiceInfo.Name); } catch {} } else { Write-Output 'WARN NO_ARABIC_VOICE'; $warned = $true } };" +
  'try { $s.Rate = [int]$env:ORBIT_RATE; } catch {};' +
  '$s.Speak($env:ORBIT_TEXT);' +
  '$s.Dispose();';

// --- WinRT engine (Windows.Media.SpeechSynthesis) — modern voices.
// Renders to a WAV byte stream, plays it with SoundPlayer.PlaySync() so the
// process exiting = audio finished (our done detection keeps working).
// Rate != 0 is applied through SSML prosody (WinRT has no Rate property).
const WINRT_SPEAK_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  '[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime];' +
  '[void][Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime];' +
  '$s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer;' +
  '$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices;' +
  '$v = $null;' +
  'if($env:ORBIT_VOICE){ $v = @($voices | Where-Object { $_.DisplayName -like (\'*\' + $env:ORBIT_VOICE + \'*\') -or $_.Id -like (\'*\' + $env:ORBIT_VOICE + \'*\') } | Select-Object -First 1)[0]; }' +
  "if(-not $v -and $env:ORBIT_AUTOAR -eq '1'){ $v = @($voices | Where-Object { $_.Language -like 'ar*' } | Select-Object -First 1)[0]; if(-not $v){ Write-Output 'WARN NO_ARABIC_VOICE' } }" +
  'if($v){ try { $s.Voice = $v; } catch {} }' +
  "$lang = 'en-US'; if($s.Voice){ $lang = $s.Voice.Language; }" +
  '$pct = 0; try { $pct = [int]$env:ORBIT_RATE * 20; } catch {};' +
  '$text = $env:ORBIT_TEXT;' +
  'if($pct -ne 0){' +
  '  $esc = [System.Security.SecurityElement]::Escape($text);' +
  '  $ssml = \'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="\' + $lang + \'"><prosody rate="\' + $pct + \'%">\' + $esc + \'</prosody></speak>\';' +
  '  ' + AS_TASK +
  '  $op = $s.SynthesizeSsmlToStreamAsync($ssml);' +
  '  $task = $asTask.MakeGenericMethod([Windows.Storage.Streams.SpeechSynthesisStream]).Invoke($null, @($op));' +
  '  $task.Wait();' +
  '  $stream = $op.GetResults();' +
  '} else {' +
  '  $stream = $s.GenerateStream($text);' +
  '}' +
  'if($stream.Size -gt 0){' +
  '  ' + AS_TASK +
  '  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0));' +
  '  $op2 = $reader.LoadAsync([uint32]$stream.Size);' +
  '  $task2 = $asTask.MakeGenericMethod([uint32]).Invoke($null, @($op2));' +
  '  $task2.Wait();' +
  '  $bytes = New-Object byte[] ([int]$stream.Size);' +
  '  $reader.ReadBytes($bytes);' +
  '  $tmp = [System.IO.Path]::GetTempFileName() + \'.wav\';' +
  '  [System.IO.File]::WriteAllBytes($tmp, $bytes);' +
  '  Add-Type -AssemblyName System.Media;' +
  '  $player = New-Object System.Media.SoundPlayer($tmp);' +
  '  $player.PlaySync();' +
  '  $player.Dispose();' +
  '  Remove-Item $tmp -ErrorAction SilentlyContinue;' +
  '}' +
  '$s.Dispose();';

const VOICES_SCRIPT =
  'Add-Type -AssemblyName System.Speech;' +
  '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
  'ForEach-Object { $_.VoiceInfo.Name }';

const WINRT_VOICES_SCRIPT =
  '[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime];' +
  '[Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { $_.DisplayName }';

function encodeCommand(ps) {
  return Buffer.from(ps, 'utf16le').toString('base64');
}

function runPS(script, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], {
      windowsHide: true
    });
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      finish();
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    };
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => finish());
    p.on('close', () => finish());
  });
}

/*ENGINESEL-START*/
// Pick which engine speaks this utterance.
//  • explicit voice → whichever engine's list contains it (unknown → winrt, the modern pool)
//  • Arabic, no explicit voice → an engine that actually HAS an Arabic voice
//  • otherwise → winrt (better-quality modern default voices)
function selectTtsEngine({ voice, isArabic, cache }) {
  const has = (list, name) => (list || []).some((n) => String(n).toLowerCase().includes(String(name).toLowerCase()));
  const arabicRe = /arab|ar-|hoda|naayf|asma|hamed|laila|taim|saleem/i;
  if (voice && String(voice).trim()) {
    if (cache) {
      if (has(cache.winrt, voice)) return 'winrt';
      if (has(cache.sapi, voice)) return 'sapi';
    }
    return 'winrt';
  }
  if (isArabic) {
    if (cache) {
      if ((cache.winrt || []).some((n) => arabicRe.test(n))) return 'winrt';
      if ((cache.sapi || []).some((n) => arabicRe.test(n))) return 'sapi';
    }
    return 'winrt'; // script still live-probes AllVoices and warns if nothing
  }
  return 'winrt';
}
/*ENGINESEL-END*/

class TTS {
  constructor() {
    this.proc = null;
    this.onDoneCb = null;
    this.voiceCache = null; // { sapi: [names], winrt: [names] }
  }

  get supported() {
    return process.platform === 'win32';
  }

  /** Enumerate voices from BOTH engines; also refreshes the internal cache. */
  async listVoices() {
    if (!this.supported) {
      this.voiceCache = { sapi: [], winrt: [] };
      return [];
    }
    const [sapi, winrt] = await Promise.all([runPS(VOICES_SCRIPT, 10000), runPS(WINRT_VOICES_SCRIPT, 10000)]);
    this.voiceCache = { sapi, winrt };
    const seen = new Set();
    const merged = [];
    for (const n of [...sapi, ...winrt]) {
      const k = n.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(n);
      }
    }
    return merged;
  }

  /**
   * Speak text. Returns {ok} immediately; onDone() fires when finished
   * (or when stopped/replaced). Only one utterance at a time.
   */
  speak({ text, voice, rate }, onDone) {
    this.stop();
    if (!this.supported) {
      const err = { ok: false, error: 'Built-in voices are Windows-only.' };
      if (onDone) onDone(err);
      return err;
    }
    const clean = String(text || '').trim();
    if (!clean) {
      if (onDone) onDone({ ok: false, error: 'Nothing to speak.' });
      return { ok: false, error: 'Nothing to speak.' };
    }
    this.onDoneCb = onDone || null;
    const isArabic = isArabicText(clean);
    const autoArabic = isArabic && !String(voice || '').trim();
    const engine = selectTtsEngine({ voice, isArabic, cache: this.voiceCache });
    const script = engine === 'sapi' ? SPEAK_SCRIPT : WINRT_SPEAK_SCRIPT;
    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
      {
        env: {
          ...process.env,
          ORBIT_VOICE: String(voice || ''),
          ORBIT_AUTOAR: autoArabic ? '1' : '0',
          ORBIT_RATE: String(Number.isFinite(+rate) ? Math.max(-10, Math.min(10, Math.round(+rate))) : 0),
          ORBIT_TEXT: clean.slice(0, 4000)
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }
    );
    let stdout = '';
    this.proc.stdout.on('data', (d) => (stdout += d.toString()));
    const finish = (payload) => {
      const cb = this.onDoneCb;
      this.onDoneCb = null;
      if (cb) cb(payload);
    };
    this.proc.on('error', (e) => {
      this.proc = null;
      finish({ ok: false, error: 'TTS failed to start: ' + (e.message || e) });
    });
    this.proc.on('close', () => {
      this.proc = null;
      const warn = stdout.includes('WARN NO_ARABIC_VOICE') ? 'no-arabic-voice' : undefined;
      finish({ ok: true, warn });
    });
    return { ok: true };
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
    const cb = this.onDoneCb;
    this.onDoneCb = null;
    if (cb) cb({ ok: true, stopped: true });
  }

  isSpeaking() {
    return !!this.proc;
  }

  /**
   * Play a WAV buffer (e.g. from an online TTS API) through SoundPlayer.
   * Same lifecycle as speak(): done fires when playback ends / stop() kills it.
   */
  playWavBuffer(buf, onDone) {
    this.stop();
    if (!this.supported) {
      const err = { ok: false, error: 'Audio playback is Windows-only.' };
      if (onDone) onDone(err);
      return err;
    }
    this.onDoneCb = onDone || null;
    const tmp = path.join(os.tmpdir(), 'orbit-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.wav');
    try {
      fs.writeFileSync(tmp, buf);
    } catch (e) {
      const cb = this.onDoneCb;
      this.onDoneCb = null;
      if (cb) cb({ ok: false, error: 'Could not write TTS audio: ' + (e.message || e) });
      return { ok: false };
    }
    const q = tmp.replace(/'/g, "''");
    const script =
      "Add-Type -AssemblyName System.Media;" +
      "$p = New-Object System.Media.SoundPlayer('" + q + "'); $p.PlaySync(); $p.Dispose();" +
      "Remove-Item '" + q + "' -ErrorAction SilentlyContinue;";
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], {
      windowsHide: true,
      stdio: 'ignore'
    });
    const finish = (payload) => {
      const cb = this.onDoneCb;
      this.onDoneCb = null;
      if (cb) cb(payload);
    };
    this.proc.on('error', (e) => {
      this.proc = null;
      finish({ ok: false, error: 'Audio playback failed: ' + (e.message || e) });
    });
    this.proc.on('close', () => {
      this.proc = null;
      try { fs.unlink(tmp, () => {}); } catch {}
      finish({ ok: true });
    });
    return { ok: true };
  }

  /** Does this PC have a LOCAL Arabic voice in either engine? null = not probed yet. */
  localArabicAvailable() {
    const c = this.voiceCache;
    if (!c) return null;
    const re = /arab|ar-|hoda|naayf|asma|hamed|laila|taim|saleem/i;
    return [...(c.winrt || []), ...(c.sapi || [])].some((n) => re.test(String(n)));
  }
}

module.exports = { TTS, isArabicText, selectTtsEngine };
