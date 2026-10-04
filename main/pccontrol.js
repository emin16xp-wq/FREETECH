// PC control — lets the AI use the mouse, keyboard, windows, files, processes,
// system settings and clipboard. Windows-only, implemented with PowerShell
// (built into Windows, zero dependencies).
// SAFETY: every sensitive action requires explicit user approval from the chat
// window, unless the user chose "full auto" mode. Read-only/benign tools
// (listing, screenshots of metadata, notifications) don't need approval.
const { execFile } = require('child_process');

const APPROVAL_TIMEOUT_MS = 90000;

function encodeCommand(ps) {
  return Buffer.from(ps, 'utf16le').toString('base64');
}

function q(s) {
  // single-quote escape for PowerShell string literals
  return `'${String(s).replace(/'/g, "''")}'`;
}

// --- tool definitions (OpenAI function-calling format) -----------------------
// approval: true → needs Allow/Deny in confirm mode
const TOOLS = [
  // ---------- see ----------
  {
    name: 'screen_size', approval: false,
    description: 'Get the screen resolution in pixels.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'screenshot', approval: true,
    description: 'Take a screenshot of the whole screen. You receive the image and can analyze it. Requires a vision-capable model.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'screenshot_window', approval: true,
    description: 'Bring a window to the front and screenshot just that window (by part of its title). Use after list_windows.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
  },
  {
    name: 'list_monitors', approval: false,
    description: 'List connected monitors/Displays with their bounds.',
    parameters: { type: 'object', properties: {} }
  },

  // ---------- mouse & keyboard ----------
  {
    name: 'mouse_move', approval: true,
    description: 'Move the mouse cursor to pixel coordinates. Glides there like a human (set smooth:false for an instant jump).',
    parameters: { type: 'object', properties: { x: { type: 'integer', description: 'pixels from left' }, y: { type: 'integer', description: 'pixels from top' }, smooth: { type: 'boolean', description: 'human-like glide (default true)' } }, required: ['x', 'y'] }
  },
  {
    name: 'mouse_click', approval: true,
    description: 'Click the mouse, optionally at specific coordinates first.',
    parameters: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' } } }
  },
  {
    name: 'mouse_drag', approval: true,
    description: 'Press and hold the left mouse button at one point, drag to another point, and release. For moving files, sliders, selections.',
    parameters: { type: 'object', properties: { fromX: { type: 'integer' }, fromY: { type: 'integer' }, toX: { type: 'integer' }, toY: { type: 'integer' } }, required: ['fromX', 'fromY', 'toX', 'toY'] }
  },
  {
    name: 'mouse_scroll', approval: true,
    description: 'Scroll the mouse wheel. Positive = up, negative = down.',
    parameters: { type: 'object', properties: { amount: { type: 'integer', description: 'clicks: e.g. 3 or -3' } }, required: ['amount'] }
  },
  {
    name: 'type_text', approval: true,
    description: 'Type text into the currently focused window (real keystrokes).',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'press_key', approval: true,
    description: 'Press a key or key combo in the focused window. Examples: "enter", "ctrl+c", "alt+tab", "ctrl+shift+esc".',
    parameters: { type: 'object', properties: { combo: { type: 'string' } }, required: ['combo'] }
  },

  // ---------- Orbit's OWN virtual mouse (ghost input — the user's mouse/keyboard never move) ----------
  {
    name: 'ghost_click', approval: true,
    description: "Orbit's OWN virtual mouse: click inside an app WITHOUT touching the user's physical cursor. Delivers the click straight to the window at screen coordinates (x, y) — even background windows. Works on most standard apps; full-screen games and hover-sensitive UI may ignore virtual clicks, so verify with a screenshot and fall back to the physical mouse tools if nothing happened.",
    parameters: { type: 'object', properties: { x: { type: 'integer', description: 'pixels from left (screen)' }, y: { type: 'integer', description: 'pixels from top (screen)' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' }, window: { type: 'string', description: 'optional: target this app window title instead of whatever is at x,y' } }, required: ['x', 'y'] }
  },
  {
    name: 'ghost_type', approval: true,
    description: "Orbit's OWN virtual keyboard: type text directly into a window without the user's keyboard or mouse being touched. Target the window by title, by a point (x,y), or the window you last ghost-clicked. Supports Unicode (Arabic too).",
    parameters: { type: 'object', properties: { text: { type: 'string' }, window: { type: 'string', description: 'app window title' }, x: { type: 'integer' }, y: { type: 'integer' } }, required: ['text'] }
  },
  {
    name: 'ghost_key', approval: true,
    description: "Orbit's OWN virtual keyboard: send a key combo (enter, ctrl+s, tab, alt+f4…) directly to a window without touching the user's keyboard. Target by window title, point, or last ghost-clicked window. Windows-key combos cannot be sent virtually.",
    parameters: { type: 'object', properties: { combo: { type: 'string' }, window: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } }, required: ['combo'] }
  },

  // ---------- files ----------
  {
    name: 'list_directory', approval: false,
    description: 'List the files and folders inside a directory.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'e.g. C:\\Users\\me\\Documents' } }, required: ['path'] }
  },
  {
    name: 'read_file', approval: true,
    description: 'Read a text file (first ~30 KB). Privacy-sensitive: needs user approval.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'write_file', approval: true,
    description: 'Create or overwrite a text file with content. Use UTF-8 safe — any text.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean', description: 'true = append instead of overwrite' } }, required: ['path', 'content'] }
  },
  {
    name: 'search_files', approval: false,
    description: 'Search files by name (and optionally by text content) under a folder. Returns up to 40 matches.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string', description: 'filename wildcard, e.g. *.txt or report*' }, text: { type: 'string', description: 'optional: find files containing this text' } }, required: ['path', 'pattern'] }
  },
  {
    name: 'delete_path', approval: true,
    description: 'Move a file or folder to the Recycle Bin (recoverable).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },

  // ---------- windows & apps ----------
  {
    name: 'list_windows', approval: false,
    description: 'List all open windows (process id, name, title).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'focus_window', approval: true,
    description: 'Bring a window to the front by (part of) its title.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
  },
  {
    name: 'close_window', approval: true,
    description: 'Politely close a window (like clicking X) by (part of) its title.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
  },
  {
    name: 'set_window', approval: true,
    description: 'Minimize, maximize, restore, move or resize a window by (part of) its title.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        action: { type: 'string', enum: ['minimize', 'maximize', 'restore', 'move', 'resize'] },
        x: { type: 'integer' }, y: { type: 'integer' },
        width: { type: 'integer' }, height: { type: 'integer' }
      },
      required: ['title', 'action']
    }
  },
  {
    name: 'list_installed_apps', approval: false,
    description: 'List the apps installed on this PC (Start Menu apps, deduplicated). Use filter to narrow, e.g. "minecraft", "chrome", "spotify". ALWAYS check here before claiming an app exists.',
    parameters: { type: 'object', properties: { filter: { type: 'string', description: 'optional name filter' } } }
  },
  {
    name: 'find_app', approval: false,
    description: 'Check if a SPECIFIC app or game is installed and/or currently running. Returns the exact launch name. Use BEFORE launch_app whenever you are not 100% sure the app exists.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'browser_search', approval: true,
    description: "Open the user's default browser with search results for a query (Google by default; engines: google, bing, duckduckgo, youtube). This is how you 'search the internet for ...'.",
    parameters: { type: 'object', properties: { query: { type: 'string' }, engine: { type: 'string', enum: ['google', 'bing', 'duckduckgo', 'youtube'] } }, required: ['query'] }
  },
  {
    name: 'launch_app', approval: true,
    description: 'Launch a program. Accepts an exe/command name ("notepad"), a full path, or a Start Menu app name like "Minecraft Launcher" (auto-resolved). The launch is VERIFIED — you get honest feedback whether the process actually started.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, args: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'open_url', approval: true,
    description: 'Open a URL in the default browser (http/https, also mailto:, steam:, spotify:, discord:).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'kill_process', approval: true,
    description: 'Force-close a process by name (e.g. "chrome") or PID. Last resort — prefer close_window.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, pid: { type: 'integer' } } }
  },

  // ---------- system ----------
  {
    name: 'system_info', approval: false,
    description: 'Get CPU load, memory usage and disk free space.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'clipboard_get', approval: true,
    description: 'Read the current clipboard text.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'clipboard_set', approval: true,
    description: 'Put text on the clipboard.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'notify', approval: false,
    description: 'Show a Windows notification balloon to the user.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['title', 'message'] }
  },
  {
    name: 'volume', approval: false,
    description: 'Control speaker volume: nudge up/down or toggle mute.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['up', 'down', 'mute'] }, steps: { type: 'integer', description: '1-50 nudges, default 4' } }, required: ['action'] }
  },

  {
    name: 'read_screen_text', approval: true,
    description: 'Capture the screen and READ all visible text using Windows built-in OCR. Returns the text found. Perfect for reading error dialogs, articles, chats on screen — no vision model needed.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'screenshot_region', approval: true,
    description: 'Screenshot only a rectangle of the screen (x, y, width, height in pixels).',
    parameters: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } }, required: ['x', 'y', 'width', 'height'] }
  },
  {
    name: 'media_key', approval: true,
    description: 'Press a media key — controls Spotify, YouTube, players: play/pause, stop, next, previous, volume up/down/mute.',
    parameters: { type: 'object', properties: { key: { type: 'string', enum: ['play_pause', 'stop', 'next', 'previous', 'volume_up', 'volume_down', 'mute'] } }, required: ['key'] }
  },
  {
    name: 'get_pixel_color', approval: false,
    description: 'Get the hex color (#RRGGBB) of the pixel at screen coordinates.',
    parameters: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] }
  },
  {
    name: 'battery', approval: false,
    description: 'Battery status: charge percent and charging state (desktops report "no battery").',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'network_info', approval: false,
    description: 'Network status: Wi-Fi name, IPv4 addresses, and whether the internet is reachable.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'wait', approval: false,
    description: 'Wait 1-60 seconds before continuing. Use between steps that need loading time (e.g. after launching a big game).',
    parameters: { type: 'object', properties: { seconds: { type: 'integer' } }, required: ['seconds'] }
  },

  // ---------- power tool ----------
  {
    name: 'run_powershell', approval: true,
    description: 'Run ANY PowerShell command and get its output. Extremely powerful: registry, services, network info, system settings, anything. The user sees the exact command before approving.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
  }
];



// PowerShell: build a full index of installed apps & games across EVERY source:
// Start Menu shortcuts, Desktop shortcuts, UWP/Store apps, registry (all programs),
// Steam libraries (appmanifest parsing), Epic Games manifests. Output: Name|Source|How
const CATALOG_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$lines = New-Object System.Collections.ArrayList
function Add-App($n,$src,$how) { $n = ($n -replace '[|\r\n]',' ').Trim(); if ($n) { [void]$lines.Add(($n + '|' + $src + '|' + $how)) } }
$smDirs = @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:AppData\Microsoft\Windows\Start Menu\Programs", "$env:USERPROFILE\Desktop", "$env:USERPROFILE\OneDrive\Desktop")
Get-ChildItem $smDirs -Recurse -Filter *.lnk | ForEach-Object { Add-App $_.BaseName 'shortcut' $_.FullName }
try { Get-StartApps | Where-Object { $_.AppID -like '*!App*' } | ForEach-Object { Add-App $_.Name 'app' $_.AppID } } catch {}
$regKeys = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')
foreach ($k in $regKeys) { Get-ItemProperty $k | Where-Object { $_.DisplayName } | ForEach-Object { Add-App $_.DisplayName 'program' ($_.DisplayIcon -replace ',.*$','') } }
$steamRoot = "\${env:ProgramFiles(x86)}\Steam"
$libs = @()
if (Test-Path ($steamRoot + '\steamapps')) { $libs += ($steamRoot + '\steamapps') }
$vdf = $steamRoot + '\steamapps\libraryfolders.vdf'
if (Test-Path $vdf) { Select-String -Path $vdf -Pattern '"path"' | ForEach-Object { $lp = (($_.Line -split '"')[3] -replace '\\', '\'); if ($lp -and (Test-Path ($lp + '\steamapps'))) { $libs += ($lp + '\steamapps') } } }
foreach ($lib in ($libs | Select-Object -Unique)) { Get-ChildItem $lib -Filter 'appmanifest_*.acf' | ForEach-Object { $acf = Get-Content $_.FullName -Raw; if ($acf -match '"name"\s*"([^"]+)"') { $appid = $_.BaseName -replace 'appmanifest_',''; Add-App $Matches[1] 'steam' ('steam://rungameid/' + $appid) } } }
$mfDir = "$env:ProgramData\Epic\EpicGamesLauncher\Data\Manifests"
if (Test-Path $mfDir) { Get-ChildItem $mfDir -Filter *.item | ForEach-Object { $j = Get-Content $_.FullName -Raw | ConvertFrom-Json; if ($j.DisplayName -and $j.AppName) { Add-App $j.DisplayName 'epic' ('com.epicgames.launcher://apps/' + $j.AppName + '?action=launch&silent=true') } } }
if ($lines.Count -eq 0) { Write-Output 'EMPTY' } else { $lines | Select-Object -Unique | Select-Object -First 600 }
`;

const MOUSE_PS = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class OrbitMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
`;

// Orbit's OWN virtual mouse — inputs are delivered directly to a target window
// via posted messages, so the USER'S physical cursor and keyboard never move.
const GHOST_PS = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class OrbitGhost {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPoint(IntPtr hWnd, POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder text, int count);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@;
$hwnd = [IntPtr]::Zero
`;

const WINMAN_PS = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class OrbitWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
`;

// Windows built-in OCR (WinRT) — reads all text on screen. No dependencies.
const OCR_PS = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function Await($WinRtTask, $ResultType) { $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap ([Math]::Min($b.Width,2560)), ([Math]::Min($b.Height,1600))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($ras.GetOutputStreamAt(0))
  $writer.WriteBytes($ms.ToArray())
  Await ($writer.StoreAsync()) ([Windows.Foundation.Storage.Streams.DataWriterStoreOperation]) | Out-Null
  Await ($writer.FlushAsync()) ([System.Boolean]) | Out-Null
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ocrEngine = Await ([Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()) ([Windows.Media.Ocr.OcrEngine])
  if (-not $ocrEngine) { Write-Output 'OCR_UNAVAILABLE'; exit }
  $result = Await ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  Write-Output 'OCR_TEXT'
  ($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine
} catch {
  Write-Output ('OCR_ERROR: ' + $_.Exception.Message)
}
`;

function findWindowPsSnippet(titleVar) {
  return `$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${titleVar}*' } | Select-Object -First 1
if (-not $p -or $p.MainWindowHandle -eq 0) { Write-Output 'NOT FOUND'; exit }`;
}

// Human key combo → virtual key codes for ghost_key (posted messages).
// Returns ordered codes: modifiers first, main key last.
function vkFor(combo) {
  const parts = String(combo || '').trim().toLowerCase().split('+').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new Error('No key given');
  const NAMED = {
    enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
    backspace: 0x08, delete: 0x2e, del: 0x2e, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, insert: 0x2d,
    shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12
  };
  for (let i = 1; i <= 12; i++) NAMED['f' + i] = 0x70 + (i - 1);
  const mods = [];
  let main = 0;
  for (const part of parts) {
    if (part === 'win' || part === 'windows' || part === 'super') {
      throw new Error('Windows-key combos cannot be sent virtually (the shell handles them globally). Use the physical press_key tool for those, or tell me the setting another way.');
    }
    let vk = NAMED[part];
    if (vk === undefined) {
      if (/^[a-z]$/.test(part)) vk = 0x41 + part.charCodeAt(0) - 97;
      else if (/^[0-9]$/.test(part)) vk = 0x30 + part.charCodeAt(0) - 48;
      else throw new Error(`Unknown key: "${part}"`);
    }
    if (vk === 0x10 || vk === 0x11 || vk === 0x12) mods.push(vk);
    else main = vk;
  }
  if (!main) throw new Error('No main key in combo (only modifiers given)');
  return [...mods, main];
}

// Human key combo ("ctrl+shift+esc") → SendKeys syntax ("^+{ESC}").
function toSendKeys(combo) {
  const parts = String(combo || '').trim().toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('No key given');
  const NAMED = {
    enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
    space: ' ', backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
    insert: '{INS}', help: '{HELP}', breakout: '{BREAK}', printscreen: '{PRTSC}'
  };
  const MODS = { ctrl: '^', control: '^', alt: '%', shift: '+' };
  const UNSUPPORTED = ['win', 'windows', 'super', 'meta'];
  let prefix = '';
  let key = null;
  for (const p of parts) {
    if (UNSUPPORTED.includes(p)) {
      throw new Error('The Windows key cannot be sent (SendKeys limit). Try "ctrl+esc" instead.');
    }
    if (MODS[p]) {
      prefix += MODS[p];
    } else if (key === null) {
      key = p;
    } else {
      throw new Error(`Cannot combine two keys: "${p}" and "${key}"`);
    }
  }
  if (key === null) throw new Error('No actual key in combo');
  if (NAMED[key]) return prefix + NAMED[key];
  if (key.length === 1) {
    if ('+^%~(){}'.includes(key)) return prefix + '{' + key + '}';
    return prefix + key;
  }
  if (/^f([1-9]|1[0-6])$/.test(key)) return prefix + '{' + key.toUpperCase() + '}';
  throw new Error(`Unknown key: "${key}"`);
}

function describe(action, args = {}) {
  switch (action) {
    case 'screenshot': return '📸 take a screenshot and look at it';
    case 'screenshot_window': return `📸 screenshot the window "${args.title}"`;
    case 'mouse_move': return `🖱️ move the mouse to (${args.x}, ${args.y})`;
    case 'mouse_click': {
      const at = args.x !== undefined ? ` at (${args.x}, ${args.y})` : '';
      const b = args.button === 'right' ? 'right-click' : 'click';
      return `🖱️ ${args.double ? 'double-' : ''}${b}${at}`;
    }
    case 'mouse_drag': return `🖱️ drag from (${args.fromX}, ${args.fromY}) to (${args.toX}, ${args.toY})`;
    case 'mouse_scroll': return `🖱️ scroll ${args.amount > 0 ? 'up' : 'down'} by ${Math.abs(args.amount || 0)}`;
    case 'type_text': return `⌨️ type: "${String(args.text || '').slice(0, 80)}"`;
    case 'press_key': return `⌨️ press ${args.combo}`;
    case 'ghost_click': return `👻 virtual-click${args.double ? ' (double)' : ''}${args.button === 'right' ? ' (right)' : ''} at (${args.x}, ${args.y}) — user's mouse untouched`;
    case 'ghost_type': return `👻 virtual-type: "${String(args.text || '').slice(0, 60)}"`;
    case 'ghost_key': return `👻 virtual-key: ${args.combo}`;
    case 'list_directory': return `📂 list folder "${args.path}"`;
    case 'read_file': return `📄 read the file "${args.path}"`;
    case 'write_file': return `✍️ ${args.append ? 'append to' : 'write'} the file "${args.path}"`;
    case 'search_files': return `🔎 search files in "${args.path}" for "${args.pattern}${args.text ? ' (containing text)' : ''}"`;
    case 'delete_path': return `🗑️ move "${args.path}" to the Recycle Bin`;
    case 'focus_window': return `🪟 focus window "${args.title}"`;
    case 'close_window': return `🪟 close window "${args.title}"`;
    case 'set_window': return `🪟 ${args.action} window "${args.title}"`;
    case 'list_installed_apps': return `📂 list installed apps${args.filter ? ` matching "${args.filter}"` : ''}`;
    case 'find_app': return `🔎 check if "${args.name}" is installed/running`;
    case 'browser_search': return `🌐 search the web for "${String(args.query || '').slice(0, 60)}"`;
    case 'launch_app': return `🚀 launch "${args.path}${args.args ? ' ' + args.args : ''}"`;
    case 'open_url': return `🌐 open "${args.url}"`;
    case 'kill_process': return `⛔ force-close "${args.name || args.pid}"`;
    case 'clipboard_get': return '📋 read the clipboard';
    case 'clipboard_set': return `📋 set clipboard to "${String(args.text || '').slice(0, 60)}"`;
    case 'read_screen_text': return '🔤 read all text currently on the screen (OCR)';
    case 'screenshot_region': return `📸 screenshot region (${args.x}, ${args.y}, ${args.width}x${args.height})`;
    case 'media_key': return `🎵 media key: ${args.key}`;
    case 'get_pixel_color': return `🎨 read pixel color at (${args.x}, ${args.y})`;
    case 'battery': return '🔋 check battery status';
    case 'network_info': return '🌐 check network status';
    case 'wait': return `⏳ wait ${args.seconds}s`;
    case 'run_powershell': return `💻 run PowerShell: ${String(args.command || '').slice(0, 120)}`;
    default: return action;
  }
}

class PcControl {
  /**
   * @param store config store
   * @param getChatWin () => BrowserWindow | null (for approval prompts)
   */
  constructor(store, getChatWin, onEvent) {
    this.store = store;
    this.getChatWin = getChatWin || (() => null);
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.canRun = process.platform === 'win32';
    this.pending = new Map(); // approval id -> resolve(bool)
    this._approvalSeq = 0;
    this._ghostHwnd = null; // last window hit by the virtual mouse
  }

  emitAction(ev) {
    if (!this.onEvent) return;
    try {
      this.onEvent(ev);
    } catch {}
  }

  settings() {
    return this.store.get('pcControl', { enabled: false, mode: 'confirm' });
  }

  enabled() {
    return this.canRun && !!this.settings().enabled;
  }

  openAiTools() {
    if (!this.enabled()) return [];
    return TOOLS.map((t) => ({
      serverId: '__pc',
      originalName: t.name,
      name: `pc__${t.name}`,
      description: `[PC control] ${t.description}`,
      inputSchema: t.parameters,
      _approval: t.approval
    }));
  }

  async requestApproval(actionDesc, send) {
    const id = 'ap_' + Date.now().toString(36) + '_' + (this._approvalSeq++);
    const win = this.getChatWin();
    if (!win || win.isDestroyed()) return false; // nowhere to ask → deny
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      this.pending.set(id, (allowed) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(!!allowed);
      });
      send({ type: 'approval_request', id, action: actionDesc });
    });
    return ok;
  }

  resolveApproval(id, allowed) {
    const res = this.pending.get(id);
    if (res) res(allowed);
  }

  // --- PowerShell runner -----------------------------------------------------
  runPS(script, timeoutMs = 15000) {
    if (!this.canRun) return Promise.reject(new Error('PC control works on Windows only.'));
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(String(stderr || err.message || err).slice(0, 400)));
          resolve(String(stdout || '').trim());
        }
      );
    });
  }

  /**
   * Execute a pc__<action> tool call.
   * Returns { text } or { content: [parts] } (for screenshots).
   */
  async call(fullName, args, { send } = {}) {
    const action = String(fullName || '').replace(/^pc__/, '');
    const def = TOOLS.find((t) => t.name === action);
    if (!def) throw new Error(`Unknown PC action: ${action}`);
    if (!this.enabled()) throw new Error('PC control is disabled in settings.');
    args = args || {};

    // Safety gate
    const mode = this.settings().mode;
    if (def.approval && mode !== 'auto') {
      const ok = await this.requestApproval(describe(action, args), send);
      if (!ok) return { text: 'The user DENIED this action. Do not try it again without asking them first.' };
    }

    switch (action) {
      case 'screen_size': {
        const out = await this.runPS(
          'Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; "W=$($b.Width) H=$($b.Height)"'
        );
        return { text: out };
      }
      case 'screenshot':
      case 'screenshot_window': {
        let pre = '';
        let rect = null;
        if (action === 'screenshot_window') {
          const title = String(args.title || '').replace(/'/g, "''");
          pre = `${WINMAN_PS}
${findWindowPsSnippet(title)}
[OrbitWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[OrbitWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500
$r = New-Object RECT
[OrbitWin]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
Write-Output ("RECT=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)")`;
          const rectOut = await this.runPS(pre, 20000);
          const m = /RECT=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(rectOut || '');
          if (!m) return { text: `No window matching "${args.title}" found. Use list_windows first.` };
          const L = parseInt(m[1], 10), T = parseInt(m[2], 10), R = parseInt(m[3], 10), B = parseInt(m[4], 10);
          rect = { x: L, y: T, w: Math.max(50, R - L), h: Math.max(50, B - T) };
        }
        const region = rect
          ? `$bx=${rect.x}; $by=${rect.y}; $bw=${rect.w}; $bh=${rect.h};`
          : `$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bx=$b.Left; $by=$b.Top; $bw=[Math]::Min($b.Width,3200); $bh=[Math]::Min($b.Height,2000);`;
        const b64 = await this.runPS(
          `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
${region}
$bmp = New-Object System.Drawing.Bitmap $bw, $bh
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bx, $by, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep=New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]70)
$bmp.Save($ms,$codec,$ep)
[Convert]::ToBase64String($ms.ToArray())`,
          60000
        );
        if (!b64 || b64.length < 1000) throw new Error('Screenshot came back empty');
        return {
          content: [
            { type: 'text', text: rect ? `Screenshot of the window captured (${rect.w}x${rect.h}). Analyze the attached image, then act on what you see.` : 'Screenshot captured. Analyze the attached image, then act on what you see.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ]
        };
      }
      case 'list_monitors': {
        const out = await this.runPS(
          'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.Bounds.ToString() }'
        );
        return { text: 'Monitors:\n' + out.split(/\r?\n/).filter(Boolean).map((s, i) => `- Monitor ${i + 1}: ${s}`).join('\n') };
      }
      case 'mouse_move': {
        const x = Number(args.x), y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be numbers');
        if (args.smooth === false) {
          this.emitAction({ kind: 'move', x: x | 0, y: y | 0 });
          await this.runPS(`${MOUSE_PS}
[OrbitMouse]::SetCursorPos(${x | 0}, ${y | 0}) | Out-Null; Write-Output "cursor at ${x | 0},${y | 0}"`);
        } else {
          // Human-like glide: ~0.4s smoothstep so the user can SEE and follow the move.
          this.emitAction({ kind: 'move', x: x | 0, y: y | 0 });
          await this.runPS(`${MOUSE_PS}
Add-Type -AssemblyName System.Windows.Forms
$from = [System.Windows.Forms.Cursor]::Position
$steps = 30
for ($i = 1; $i -le $steps; $i++) {
  $t = $i / $steps
  $e = $t * $t * (3 - 2 * $t)
  $gx = [int]([Math]::Round(${x | 0} * $e + $from.X * (1 - $e)))
  $gy = [int]([Math]::Round(${y | 0} * $e + $from.Y * (1 - $e)))
  [OrbitMouse]::SetCursorPos($gx, $gy) | Out-Null
  Start-Sleep -Milliseconds 12
}
Write-Output "cursor at ${x | 0},${y | 0}"`);
        }
        return { text: `Mouse moved to (${x | 0}, ${y | 0}).` };
      }
      case 'mouse_click': {
        const x = args.x !== undefined ? Number(args.x) : null;
        const y = args.y !== undefined ? Number(args.y) : null;
        const btn = args.button === 'right' ? 'right' : 'left';
        const dbl = args.double ? true : false;
        const down = btn === 'right' ? 0x0008 : 0x0002;
        const up = btn === 'right' ? 0x0010 : 0x0004;
        const clicks = dbl ? 2 : 1;
        let pre = '';
        if (x !== null && y !== null) {
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be numbers');
          pre = `[OrbitMouse]::SetCursorPos(${x | 0}, ${y | 0}) | Out-Null\nStart-Sleep -Milliseconds 120\n`;
        }
        this.emitAction({ kind: 'click', x: x !== null ? x | 0 : null, y: y !== null ? y | 0 : null, button: btn, double: dbl });
        const ev = [];
        for (let i = 0; i < clicks; i++) {
          ev.push('[OrbitMouse]::mouse_event(' + down + ',0,0,0,[UIntPtr]::Zero)');
          ev.push('Start-Sleep -Milliseconds 40');
          ev.push('[OrbitMouse]::mouse_event(' + up + ',0,0,0,[UIntPtr]::Zero)');
          if (i < clicks - 1) ev.push('Start-Sleep -Milliseconds 60');
        }
        await this.runPS(`${MOUSE_PS}
${pre}${ev.join('\n')}
Write-Output "clicked"`);
        return { text: `${dbl ? 'Double-' : ''}${btn} click done${x !== null ? ` at (${x | 0}, ${y | 0})` : ''}.` };
      }
      case 'mouse_drag': {
        const x1 = Math.round(Number(args.fromX)), y1 = Math.round(Number(args.fromY));
        const x2 = Math.round(Number(args.toX)), y2 = Math.round(Number(args.toY));
        for (const v of [x1, y1, x2, y2]) if (!Number.isFinite(v)) throw new Error('drag coordinates must be numbers');
        this.emitAction({ kind: 'drag', fromX: x1, fromY: y1, toX: x2, toY: y2 });
        await this.runPS(`${MOUSE_PS}
[OrbitMouse]::SetCursorPos(${x1}, ${y1}) | Out-Null
Start-Sleep -Milliseconds 150
[OrbitMouse]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
for ($i = 1; $i -le 20; $i++) {
  $x = [int](${x1} + (${x2} - ${x1}) * $i / 20)
  $y = [int](${y1} + (${y2} - ${y1}) * $i / 20)
  [OrbitMouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 18
}
Start-Sleep -Milliseconds 120
[OrbitMouse]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
Write-Output "dragged"`, 30000);
        return { text: `Dragged from (${x1}, ${y1}) to (${x2}, ${y2}).` };
      }
      case 'mouse_scroll': {
        const amount = Number(args.amount || 0);
        if (!Number.isFinite(amount) || amount === 0) throw new Error('amount must be a non-zero number');
        const data = Math.max(-30, Math.min(30, amount | 0)) * 120;
        const val = data >>> 0; // uint
        await this.runPS(`${MOUSE_PS}
[OrbitMouse]::mouse_event(0x0800,0,0,${val},[UIntPtr]::Zero)
Write-Output "scrolled"`);
        return { text: `Scrolled ${amount > 0 ? 'up' : 'down'} ${Math.abs(amount | 0)}.` };
      }
      case 'type_text': {
        this.emitAction({ kind: 'type', text: String(args.text || '').slice(0, 60) });
        const text = String(args.text || '');
        if (!text) throw new Error('No text given');
        const escaped = text.replace(/([+\^%~(){}[\]])/g, '{$1}');
        await this.runPS(
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(@'
${escaped}
'@); Write-Output "typed"`,
          30000
        );
        return { text: `Typed ${text.length} characters into the focused window.` };
      }
      case 'press_key': {
        this.emitAction({ kind: 'key', combo: String(args.combo || '') });
        const keys = toSendKeys(args.combo);
        await this.runPS(
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}'); Write-Output "pressed"`
        );
        return { text: `Pressed ${args.combo}.` };
      }

      // ---- Orbit's OWN virtual mouse/keyboard: the user's mouse & keyboard never move ----
      case 'ghost_click': {
        const x = Math.round(Number(args.x));
        const y = Math.round(Number(args.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y (screen coordinates) are required');
        const btn = args.button === 'right' ? 'right' : 'left';
        const dbl = args.double ? true : false;
        this.emitAction({ kind: 'click', x, y, button: btn, double: dbl, ghost: true });
        let pre = '';
        if (args.window) pre = findWindowPsSnippet(String(args.window).replace(/'/g, "''")) + '\n$hwnd = $p.MainWindowHandle\n';
        const script = `${GHOST_PS}
${pre}$pt = New-Object OrbitGhost+POINT
$pt.X = ${x}; $pt.Y = ${y}
if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [OrbitGhost]::WindowFromPoint($pt) }
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'GHOST FAIL no-window'; exit }
$child = [OrbitGhost]::ChildWindowFromPoint($hwnd, $pt)
if ($child -ne [IntPtr]::Zero) { $hwnd = $child }
[OrbitGhost]::ScreenToClient($hwnd, [ref]$pt) | Out-Null
$l = [IntPtr](($pt.Y -shl 16) -bor ($pt.X -band 0xFFFF))
$sb = New-Object System.Text.StringBuilder 512
[OrbitGhost]::GetWindowTextW($hwnd, $sb, 512) | Out-Null
$wtitle = $sb.ToString()
$down = [uint32]0x0201; $up = [uint32]0x0202; $wp = [IntPtr]1
if ('${btn}' -eq 'right') { $down = [uint32]0x0204; $up = [uint32]0x0205; $wp = [IntPtr]2 }
if (${dbl ? 1 : 0} -eq 1) { [OrbitGhost]::PostMessage($hwnd, [uint32]0x0203, $wp, $l) | Out-Null; Start-Sleep -Milliseconds 40 }
[OrbitGhost]::PostMessage($hwnd, $down, $wp, $l) | Out-Null
Start-Sleep -Milliseconds 60
[OrbitGhost]::PostMessage($hwnd, $up, [IntPtr]0, $l) | Out-Null
Write-Output ("GHOST OK hwnd=" + $hwnd + " title=" + $wtitle)`;
        const out = await this.runPS(script, 20000);
        if (/GHOST FAIL/.test(out)) return { text: 'Virtual click failed — no window found at that point. Take a screenshot and choose another spot.' };
        const mh = String(out).match(/hwnd=(\d+)/);
        if (mh) this._ghostHwnd = mh[1];
        const mt = String(out).match(/title=(.*)/);
        const wname = mt && mt[1].trim() ? ` "${mt[1].trim().slice(0, 40)}"` : '';
        return { text: `Virtual ${dbl ? 'double-' : ''}${btn} click delivered into${wname || ' the'} window at (${x}, ${y}) — the user's mouse never moved. Take a screenshot to VERIFY it landed; if nothing happened, this app needs the physical mouse tools.` };
      }
      case 'ghost_type': {
        const text = String(args.text || '');
        if (!text) throw new Error('No text given');
        const codes = [];
        for (let i = 0; i < Math.min(text.length, 4000); i++) {
          let c = text.charCodeAt(i);
          if (c === 10) c = 13; // newline → CR (apps treat WM_CHAR 13 as Enter)
          codes.push(c);
        }
        this.emitAction({ kind: 'type', text: text.slice(0, 60), ghost: true });
        let target = '';
        if (args.window) target = findWindowPsSnippet(String(args.window).replace(/'/g, "''")) + '\n$hwnd = $p.MainWindowHandle\n';
        else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
          target = `$pt = New-Object OrbitGhost+POINT
$pt.X = ${Math.round(Number(args.x))}; $pt.Y = ${Math.round(Number(args.y))}
$hwnd = [OrbitGhost]::WindowFromPoint($pt)
`;
        } else if (this._ghostHwnd) target = `$hwnd = [IntPtr]${this._ghostHwnd}
`;
        else throw new Error('No target: give the window title, a point (x,y), or ghost_click the window first.');
        const script = `${GHOST_PS}
${target}$codes = @(${codes.join(',')})
foreach ($c in $codes) {
  [OrbitGhost]::PostMessage($hwnd, [uint32]0x0002, [IntPtr]$c, [IntPtr]0) | Out-Null
  Start-Sleep -Milliseconds 4
}
Write-Output ("GHOST OK hwnd=" + $hwnd + " chars=" + $codes.Count)`;
        const out = await this.runPS(script, 120000);
        if (/NOT FOUND/.test(out)) return { text: `No window matching "${args.window}" found. Use list_windows first.` };
        const mh = String(out).match(/hwnd=(\d+)/);
        if (mh) this._ghostHwnd = mh[1];
        return { text: `Typed ${codes.length} characters into the window virtually — the user's keyboard never moved. VERIFY with a screenshot.` };
      }
      case 'ghost_key': {
        const vks = vkFor(args.combo);
        this.emitAction({ kind: 'key', combo: String(args.combo || ''), ghost: true });
        let target = '';
        if (args.window) target = findWindowPsSnippet(String(args.window).replace(/'/g, "''")) + '\n$hwnd = $p.MainWindowHandle\n';
        else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
          target = `$pt = New-Object OrbitGhost+POINT
$pt.X = ${Math.round(Number(args.x))}; $pt.Y = ${Math.round(Number(args.y))}
$hwnd = [OrbitGhost]::WindowFromPoint($pt)
`;
        } else if (this._ghostHwnd) target = `$hwnd = [IntPtr]${this._ghostHwnd}
`;
        else throw new Error('No target: give the window title, a point (x,y), or ghost_click the window first.');
        const mods = vks.slice(0, -1);
        const main = vks[vks.length - 1];
        const lines = [];
        for (const m of mods) lines.push(`[OrbitGhost]::PostMessage($hwnd, [uint32]0x0100, [IntPtr]${m}, [IntPtr]0) | Out-Null`);
        lines.push(`[OrbitGhost]::PostMessage($hwnd, [uint32]0x0100, [IntPtr]${main}, [IntPtr]0) | Out-Null`);
        lines.push('Start-Sleep -Milliseconds 40');
        lines.push(`[OrbitGhost]::PostMessage($hwnd, [uint32]0x0101, [IntPtr]${main}, [IntPtr][uint32]0xC0000000) | Out-Null`);
        for (const m of mods.slice().reverse()) lines.push(`[OrbitGhost]::PostMessage($hwnd, [uint32]0x0101, [IntPtr]${m}, [IntPtr][uint32]0xC0000000) | Out-Null`);
        const script = `${GHOST_PS}
${target}${lines.join('\n')}
Write-Output ("GHOST OK hwnd=" + $hwnd + " keys=${vks.length}")`;
        const out = await this.runPS(script, 20000);
        if (/NOT FOUND/.test(out)) return { text: `No window matching "${args.window}" found. Use list_windows first.` };
        const mh = String(out).match(/hwnd=(\d+)/);
        if (mh) this._ghostHwnd = mh[1];
        return { text: `Sent ${args.combo} virtually into the window — the user's keyboard never moved. VERIFY with a screenshot.` };
      }

      // ---------- files ----------
      case 'list_directory': {
        const p = q(args.path);
        const out = await this.runPS(`if (-not (Test-Path -LiteralPath ${p})) { Write-Output 'NOT FOUND'; exit }
$items = Get-ChildItem -LiteralPath ${p} -Force -ErrorAction SilentlyContinue | Select-Object -First 200
if (-not $items) { Write-Output '(empty folder)'; exit }
$items | ForEach-Object { $t = 'FILE'; if ($_.PSIsContainer) { $t = 'DIR ' }; "$t\`t$($_.Name)\`t$(if ($_.PSIsContainer) { '' } else { $_.Length })" }`);
        if (/NOT FOUND/.test(out)) return { text: `Folder not found: ${args.path}` };
        return { text: `Contents of ${args.path}:\n` + out.split(/\r?\n/).filter(Boolean).map((l) => '- ' + l.replace(/\t/g, '  ')).join('\n') };
      }
      case 'read_file': {
        const p = q(args.path);
        const out = await this.runPS(`if (-not (Test-Path -LiteralPath ${p} -PathType Leaf)) { Write-Output 'NOT FOUND'; exit }
$raw = Get-Content -LiteralPath ${p} -Raw -Encoding UTF8 -ErrorAction Stop
if ($null -eq $raw) { $raw = '' }
if ($raw.Length -gt 30000) { $raw.Substring(0, 30000) + "[TRUNCATED — file is $($raw.Length) chars]" } else { $raw }`, 20000);
        if (/^NOT FOUND/.test(out)) return { text: `File not found: ${args.path}` };
        return { text: out || '(empty file)' };
      }
      case 'write_file': {
        const p = q(args.path);
        const b64 = Buffer.from(String(args.content ?? ''), 'utf8').toString('base64');
        // File.AppendText / CreateText already return a StreamWriter (UTF-8, no BOM).
        // Content travels as base64 → immune to any escaping issues.
        await this.runPS(`$content = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$dir = Split-Path -Parent ${p}
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$sw = ${args.append ? `[System.IO.File]::AppendText(${p})` : `[System.IO.File]::CreateText(${p})`}
$sw.Write($content)
$sw.Dispose()
Write-Output "written"`, 20000);
        return { text: `${args.append ? 'Appended to' : 'Wrote'} ${args.path} (${String(args.content ?? '').length} chars).` };
      }
      case 'search_files': {
        const p = q(args.path);
        const pat = q(String(args.pattern || '*'));
        if (args.text) {
          const t = q(String(args.text));
          const out = await this.runPS(`Get-ChildItem -LiteralPath ${p} -Recurse -Filter ${pat} -File -ErrorAction SilentlyContinue | Select-String -Pattern ${t} -List -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object { $_.Path }`, 45000);
          const lines = (out || '').split(/\r?\n/).filter(Boolean);
          return { text: lines.length ? `Files containing ${args.text}:\n` + lines.map((l) => '- ' + l).join('\n') : 'No matches found.' };
        }
        const out = await this.runPS(`Get-ChildItem -LiteralPath ${p} -Recurse -Filter ${pat} -File -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object { $_.FullName }`, 45000);
        const lines = (out || '').split(/\r?\n/).filter(Boolean);
        return { text: lines.length ? 'Found:\n' + lines.map((l) => '- ' + l).join('\n') : 'No matches found.' };
      }
      case 'delete_path': {
        const p = q(args.path);
        const out = await this.runPS(`Add-Type -AssemblyName Microsoft.VisualBasic
if (-not (Test-Path -LiteralPath ${p})) { Write-Output 'NOT FOUND'; exit }
[System.IO.FileInfo]$fi = ${p}
if ($fi.Attributes -band [System.IO.FileAttributes]::Directory) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${p}, 'OnlyErrorDialogs', 'SendToRecycleBin')
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${p}, 'OnlyErrorDialogs', 'SendToRecycleBin')
}
Write-Output "recycled"`, 30000);
        if (/^NOT FOUND/.test(out)) return { text: `Not found: ${args.path}` };
        return { text: `Moved ${args.path} to the Recycle Bin (recoverable).` };
      }

      // ---------- windows & apps ----------
      case 'list_windows': {
        const out = await this.runPS(
          `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)" }`
        );
        const lines = out.split(/\r?\n/).filter(Boolean);
        if (!lines.length) return { text: 'No windows with titles are open.' };
        return { text: 'Open windows (id|process|title):\n' + lines.map((l) => '- ' + l.split('|').slice(1).join(' — ')).join('\n') };
      }
      case 'focus_window': {
        const title = String(args.title || '').replace(/'/g, "''");
        const out = await this.runPS(`${WINMAN_PS}
${findWindowPsSnippet(title)}
[OrbitWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 150
[OrbitWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Write-Output ("focused: " + $p.MainWindowTitle)`);
        if (/NOT FOUND/.test(out)) return { text: `No window matching "${args.title}" found. Use list_windows to see what's open.` };
        return { text: 'Focused: ' + out.replace(/^focused: /, '') };
      }
      case 'close_window': {
        const title = String(args.title || '').replace(/'/g, "''");
        const out = await this.runPS(`$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${title}*' } | Select-Object -First 1
if (-not $p) { Write-Output 'NOT FOUND'; exit }
$ok = $p.CloseMainWindow()
Write-Output ("closed=" + $ok + " was=" + $p.MainWindowTitle)`);
        if (/NOT FOUND/.test(out)) return { text: `No window matching "${args.title}" found.` };
        return { text: /closed=True/.test(out) ? 'Closed: ' + out.split('was=')[1] : 'Could not close gracefully (it may have unsaved work).' };
      }
      case 'set_window': {
        const title = String(args.title || '').replace(/'/g, "''");
        const act = String(args.action || '');
        const SHOW = { minimize: 6, maximize: 3, restore: 9 };
        let body = '';
        if (SHOW[act] !== undefined) {
          body = `[OrbitWin]::ShowWindow($p.MainWindowHandle, ${SHOW[act]}) | Out-Null`;
        } else if (act === 'move' || act === 'resize') {
          const x = args.x !== undefined ? Math.round(Number(args.x)) : null;
          const y = args.y !== undefined ? Math.round(Number(args.y)) : null;
          const w = args.width !== undefined ? Math.round(Number(args.width)) : null;
          const h = args.height !== undefined ? Math.round(Number(args.height)) : null;
          body = `$r = New-Object RECT
[OrbitWin]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$nx = ${x !== null ? x : '$r.Left'}
$ny = ${y !== null ? y : '$r.Top'}
$nw = ${w !== null ? w : '($r.Right - $r.Left)'}
$nh = ${h !== null ? h : '($r.Bottom - $r.Top)'}
[OrbitWin]::MoveWindow($p.MainWindowHandle, $nx, $ny, $nw, $nh, $true) | Out-Null`;
        } else {
          throw new Error('action must be minimize, maximize, restore, move or resize');
        }
        const out = await this.runPS(`${WINMAN_PS}
${findWindowPsSnippet(title)}
${body}
Write-Output "done"`, 20000);
        if (/NOT FOUND/.test(out)) return { text: `No window matching "${args.title}" found. Use list_windows first.` };
        return { text: `${act} done on "${args.title}".` };
      }
      case 'launch_app': {
        const p = String(args.path || '').trim();
        if (!p) throw new Error('No path given');
        const target = p.replace(/'/g, "''");

        // STEP 1 — direct exe/command/protocol, then Start Menu & Desktop shortcuts.
        const step1 = await this.runPS(`$ErrorActionPreference = 'SilentlyContinue'
$target = '${target}'
try { Start-Process -FilePath $target -ErrorAction Stop; Write-Output 'OK direct'; exit } catch {}
$lnk = Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:AppData\Microsoft\Windows\Start Menu\Programs", "$env:USERPROFILE\Desktop", "$env:USERPROFILE\OneDrive\Desktop" -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -like "*$target*" } | Select-Object -First 1
if ($lnk) { try { Start-Process -FilePath $lnk.FullName -ErrorAction Stop; Write-Output ('OK shortcut: ' + $lnk.BaseName); exit } catch {} }
Write-Output 'NO'`, 45000);

        let how = null, src = null, via = null;
        if (step1.startsWith('OK direct')) { how = p; src = 'direct'; via = p; }
        else if (step1.startsWith('OK shortcut:')) { how = null; src = 'shortcut'; via = step1.slice('OK shortcut:'.length).trim(); }

        // STEP 2 — full catalog: Steam / Epic / Store / registry programs.
        if (!src) {
          const catalogCore = CATALOG_PS.split('\n').filter((l) => !l.startsWith('if ($lines.Count -eq 0)')).join('\n');
          const out = await this.runPS(catalogCore, 90000);
          const needle = p.toLowerCase();
          const match = out.split(/\r?\n/).filter(Boolean).find((l) => l.toLowerCase().split('|')[0].includes(needle));
          if (match) {
            const parts = match.split('|');
            how = parts[2];
            src = parts[1];
            via = parts[0];
          }
        }

        if (!src) {
          return {
            text: `Could not launch "${p}" — checked direct commands, Start Menu/Desktop shortcuts, Store apps, Steam and Epic game libraries. It is not installed on this PC. Do NOT tell the user it opened. Be honest: say it's not installed, and offer to open its official download page (open_url) or run list_installed_apps to show what IS available.`
          };
        }

        // STEP 3 — launch via the resolved method (skipped if a shortcut already started it).
        if (how) {
          const launchTarget = src === 'app' ? 'shell:AppsFolder\\' + how : how;
          await this.runPS(`Start-Process -FilePath '${launchTarget.replace(/'/g, "''")}'; Start-Sleep -Milliseconds 500; Write-Output 'launched'`, 30000);
        }

        // STEP 4 — VERIFY honestly, per launch type.
        const probe = { steam: 'steam', epic: 'EpicGamesLauncher', direct: require('path').win32.basename(String(via).replace(/\.exe$/i, '')), shortcut: String(via), program: require('path').win32.basename(String(how || 'x').replace(/\.exe$/i, '')) }[src] || String(via);
        const safeProbe = probe.replace(/'/g, "''");
        const probeOut = await this.runPS(`$pr = @(Get-Process | Where-Object { $_.ProcessName -like '*${safeProbe}*' } | Select-Object -First 3 -ExpandProperty ProcessName -Unique)
if ($pr.Count -gt 0) { Write-Output ('RUNNING: ' + ($pr -join ', ')) } else { Write-Output 'UNCONFIRMED' }`, 30000);
        const viaTxt = { steam: ' via Steam', epic: ' via Epic Games Launcher', app: ' (Store app)' }[src] || '';
        if (/^RUNNING: /.test(probeOut)) {
          return { text: `✓ Launched "${p}"${viaTxt} — verified running (process: ${probeOut.slice(9).trim()}).` };
        }
        if (src === 'steam' || src === 'epic') {
          return { text: `${src === 'steam' ? 'Steam' : 'Epic Launcher'} is starting "${p}" — big games can take 30–60s to appear. Give it a moment, then verify with list_windows or a screenshot.` };
        }
        return { text: `Started "${p}"${viaTxt}, but the process isn't confirmed yet. Check with list_windows or a screenshot before calling it fully up.` };
      }
      case 'open_url': {
        const url = String(args.url || '').trim();
        if (!/^(https?:\/\/|mailto:|steam:|spotify:|discord:|slack:)/i.test(url)) {
          if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(url)) {
            return this.call('pc__open_url', { url: 'https://' + url }, { send });
          }
          throw new Error('Unsupported URL scheme. Use http(s), mailto:, steam:, spotify:, discord: or slack:.');
        }
        await this.runPS(`Start-Process ${q(url)}; Start-Sleep -Milliseconds 300; Write-Output "opened"`, 15000);
        return { text: `Opened ${url} in the default browser/app.` };
      }
      case 'kill_process': {
        let target = '';
        if (args.pid !== undefined && Number.isFinite(Number(args.pid))) target = `-Id ${Math.round(Number(args.pid))}`;
        else if (args.name) target = `-Name ${q(String(args.name))}`;
        else throw new Error('Provide a process name or pid');
        const out = await this.runPS(`$procs = Get-Process ${target} -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output 'NOT FOUND'; exit }
$procs | Stop-Process -Force
Write-Output ("killed " + @($procs).Count + " process(es)")`, 20000);
        if (/^NOT FOUND/.test(out)) return { text: 'No such process running.' };
        return { text: out + ' (force-closed — unsaved work may be lost).' };
      }

      // ---------- system ----------
      case 'system_info': {
        const out = await this.runPS(`$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
$ramTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$ramFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
"CPU: $cpu% | RAM: $ramFreeGB GB free of $ramTotalGB GB"
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $fr = [math]::Round($_.FreeSpace/1GB,0); $to = [math]::Round($_.Size/1GB,0); "Disk $($_.DeviceID) $fr GB free of $to GB" }`, 20000);
        return { text: out };
      }
      case 'list_installed_apps': {
        const filter = String(args.filter || '').trim().toLowerCase();
        const out = await this.runPS(CATALOG_PS, 90000);
        if (/^EMPTY/.test(out.trim())) return { text: 'No installed apps found (unexpected).' };
        let lines = out.split(/\r?\n/).filter(Boolean);
        if (filter) lines = lines.filter((l) => l.toLowerCase().split('|')[0].includes(filter));
        const LABEL = { shortcut: 'app shortcut', app: 'Store/UWP app', program: 'installed program', steam: 'Steam game', epic: 'Epic game' };
        lines = lines.slice(0, 150);
        return {
          text: `Installed apps & games${filter ? ` matching "${filter}"` : ''} (${lines.length}):\n` +
            lines.map((l) => {
              const [n, src] = l.split('|');
              return `- ${n}  (${LABEL[src] || src})`;
            }).join('\n') +
            '\nLaunch any of these with launch_app using its exact name.'
        };
      }
      case 'find_app': {
        const name = String(args.name || '').trim();
        if (!name) throw new Error('No app name given');
        const needle = name.toLowerCase();
        const out = await this.runPS(CATALOG_PS, 90000);
        let lines = out.split(/\r?\n/).filter(Boolean);
        const matches = lines.filter((l) => l.toLowerCase().split('|')[0].includes(needle)).slice(0, 8);
        const running = await this.runPS(
          `$p = Get-Process | Where-Object { $_.ProcessName -like '*${name.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessName -Unique -First 5; if ($p) { Write-Output ($p -join ', ') } else { Write-Output 'no' }`,
          20000
        );
        if (!matches.length) {
          return {
            text: `"${name}" was not found anywhere on this PC — checked Start Menu shortcuts, Desktop, Store/UWP apps, installed programs (registry), Steam library and Epic Games library. Running now: ${running}. Be honest with the user: it is not installed. Offer to open its official download page with open_url.`
          };
        }
        const LABEL = { shortcut: 'app shortcut', app: 'Store/UWP app', program: 'installed program', steam: 'Steam game (launches via Steam)', epic: 'Epic game (launches via Epic Launcher)' };
        const detail = matches.map((l) => {
          const [n, src] = l.split('|');
          return `- ${n} — ${LABEL[src] || src}`;
        }).join('\n');
        return {
          text: `"${name}" IS on this PC:\n${detail}\nRunning now: ${running}.\nLaunch it with launch_app (it resolves the right way automatically — including Steam/Epic protocol launches).`
        };
      }
      case 'browser_search': {
        const query = String(args.query || '').trim();
        if (!query) throw new Error('No search query given');
        const engines = {
          google: 'https://www.google.com/search?q=',
          bing: 'https://www.bing.com/search?q=',
          duckduckgo: 'https://duckduckgo.com/?q=',
          youtube: 'https://www.youtube.com/results?search_query='
        };
        const engine = engines[String(args.engine || 'google')] ? String(args.engine || 'google') : 'google';
        const url = engines[engine] + encodeURIComponent(query).replace(/%20/g, '+');
        await this.runPS(`Start-Process ${q(url)}; Start-Sleep -Milliseconds 300; Write-Output "opened"`, 15000);
        return { text: `Opened ${engine} search for "${query}" in the default browser.` };
      }
      case 'clipboard_get': {
        const out = await this.runPS('Get-Clipboard -Format Text | Out-String');
        return { text: out ? 'Clipboard:\n' + out.slice(0, 5000) : 'Clipboard is empty.' };
      }
      case 'clipboard_set': {
        await this.runPS(`Set-Clipboard -Value ${q(String(args.text ?? ''))}; Write-Output "set"`);
        return { text: 'Clipboard updated.' };
      }
      case 'notify': {
        const t = String(args.title || 'Orbit AI').slice(0, 60);
        const m = String(args.message || '').slice(0, 200);
        await this.runPS(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(5000, ${q(t)}, ${q(m)}, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 6
$n.Dispose()
Write-Output "notified"`, 20000);
        return { text: 'Notification shown to the user.' };
      }
      case 'volume': {
        const act = String(args.action || '');
        const steps = Math.max(1, Math.min(50, Math.round(Number(args.steps || 4))));
        const code = act === 'mute' ? 0xAD : act === 'down' ? 0xAE : act === 'up' ? 0xAF : null;
        if (!code) throw new Error('action must be up, down or mute');
        const presses = act === 'mute' ? 1 : steps;
        const lines = [];
        for (let i = 0; i < presses; i++) lines.push(`[OrbitMouse]::keybd_event(${code},0,0,0,[UIntPtr]::Zero); [OrbitMouse]::keybd_event(${code},0,2,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 25`);
        await this.runPS(`${MOUSE_PS}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class OrbitKeys { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }
"@
${lines.join('\n')}
Write-Output "volume ${act}"`);
        return { text: act === 'mute' ? 'Volume muted/unmuted.' : `Volume nudged ${act} ${steps} step(s).` };
      }

      case 'read_screen_text': {
        const out = await this.runPS(OCR_PS, 90000);
        if (/OCR_UNAVAILABLE/.test(out)) {
          return { text: 'Windows OCR is not available. Install a language pack: Settings → Time & Language → Language → add English (or your language), then try again. Alternatively use screenshot with a vision model.' };
        }
        const text = out.replace(/^OCR_TEXT\r?\n/, '').trim();
        return { text: text ? 'Text visible on screen:\n' + text.slice(0, 8000) : 'No readable text found on screen.' };
      }
      case 'screenshot_region': {
        const x = Math.round(Number(args.x)), y = Math.round(Number(args.y));
        const w = Math.max(50, Math.min(3200, Math.round(Number(args.width))));
        const h = Math.max(50, Math.min(2000, Math.round(Number(args.height))));
        if (![x, y].every(Number.isFinite)) throw new Error('x and y must be numbers');
        const b64 = await this.runPS(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bx=${x}; $by=${y}; $bw=${w}; $bh=${h};
$bmp = New-Object System.Drawing.Bitmap $bw, $bh
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bx, $by, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep=New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]70)
$bmp.Save($ms,$codec,$ep)
[Convert]::ToBase64String($ms.ToArray())`, 60000);
        if (!b64 || b64.length < 1000) throw new Error('Region screenshot came back empty');
        return {
          content: [
            { type: 'text', text: `Region screenshot captured (${w}x${h} at ${x},${y}). Analyze the attached image.` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ]
        };
      }
      case 'media_key': {
        const VK = { play_pause: 0xB3, stop: 0xB2, next: 0xB0, previous: 0xB1, volume_up: 0xAF, volume_down: 0xAE, mute: 0xAD };
        const code = VK[String(args.key)];
        if (!code) throw new Error('Unknown media key');
        await this.runPS(`Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class OrbitMedia { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }
"@
[OrbitMedia]::keybd_event(${code},0,0,0,[UIntPtr]::Zero)
[OrbitMedia]::keybd_event(${code},0,2,0,[UIntPtr]::Zero)
Write-Output "pressed"`);
        return { text: `Media key ${args.key} pressed.` };
      }
      case 'get_pixel_color': {
        const x = Math.round(Number(args.x)), y = Math.round(Number(args.y));
        if (![x, y].every(Number.isFinite)) throw new Error('x and y must be numbers');
        const out = await this.runPS(`Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap 1, 1
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size 1, 1))
$c = $b.GetPixel(0, 0)
'#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B`);
        return { text: `Color at (${x}, ${y}): ${out}` };
      }
      case 'battery': {
        const out = await this.runPS(`$b = Get-CimInstance Win32_Battery
if (-not $b) { Write-Output 'No battery — desktop PC (always plugged in).' ; exit }
$st = switch ($b.BatteryStatus) { 1 { 'discharging' } 2 { 'charging (on AC)' } default { 'status code ' + $b.BatteryStatus } }
"Battery: $([int]$b.EstimatedChargeRemaining)% — $st"`);
        return { text: out };
      }
      case 'network_info': {
        const out = await this.runPS(`$wifi = ''
try { $m = netsh wlan show interfaces | Select-String '\\sSSID\\s'; if ($m) { $wifi = ($m[0].ToString() -split ':', 2)[1].Trim() } } catch {}
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -ne 'Loopback Pseudo-Interface 1' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 4 | ForEach-Object { $_.InterfaceAlias + ' = ' + $_.IPAddress }
$net = Test-Connection -ComputerName 1.1.1.1 -Count 1 -Quiet -ErrorAction SilentlyContinue
$wifiTxt = if ($wifi) { 'Wi-Fi: ' + $wifi } else { 'Wi-Fi: not connected (or ethernet)' }
"Internet: " + $(if ($net) { 'reachable ✓' } else { 'NOT reachable ✗' })
$wifiTxt
Adapters:
"  " + ($ips -join ([Environment]::NewLine + '  '))`, 30000);
        return { text: out };
      }
      case 'wait': {
        const secs = Math.max(1, Math.min(60, Math.round(Number(args.seconds || 5))));
        await this.runPS(`Start-Sleep -Seconds ${secs}; Write-Output "waited ${secs}s"`, secs * 1000 + 15000);
        return { text: `Waited ${secs} second(s).` };
      }

      // ---------- power tool ----------
      case 'run_powershell': {
        const cmd = String(args.command || '').trim();
        if (!cmd) throw new Error('No command given');
        const out = await this.runPS(cmd, 120000);
        return { text: out ? out.slice(0, 20000) : '(command ran, no output)' };
      }

      default:
        throw new Error(`Unhandled PC action: ${action}`);
    }
  }
}

module.exports = { PcControl, toSendKeys, vkFor, describe, TOOLS };
