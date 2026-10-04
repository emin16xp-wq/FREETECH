# Orbit AI 🔮

A floating AI assistant for Windows. A small glowing orb sits on top of your other windows —
**drag it anywhere, click it to chat**. Bring your own API key from **Groq**, **OpenRouter** or
**NVIDIA** (or run a model fully offline), and extend it with **MCP connectors** (files, terminal,
web, games, anything that speaks the [Model Context Protocol](https://modelcontextprotocol.io)).

```
┌─────────────┐      click      ┌──────────────┐
│  🔮 orb     │ ──────────────▶ │  chat panel  │──▶ Groq / OpenRouter / NVIDIA / local model
│  (draggable)│                 │  (streaming) │──▶ MCP tools (files, games, apps…)
└─────────────┘                 └──────────────┘
```

## Features

- **Floating orb** — always-on-top button with appear/disappear animations, drag anywhere, click to chat. Its position is remembered.
- **Global hotkey** (default `Alt+Space`) — show or hide the orb from any app.
- **Four providers, one model picker** — Groq ⚡, OpenRouter (400+ models), NVIDIA NIM, and **Local** (Hermes, llama.cpp, Ollama, LM Studio — free, offline, private). Model lists load live; vision-capable models are tagged 👁.
- **Honest key testing** — the *Test* button sends a real tiny message to the provider, so a wrong key never shows as working.
- **Vision** 📷 — attach images (📎, drag & drop, or Ctrl+V a screenshot), or capture your screen and ask about it.
- **Files** 📄 — attach text and code files (`.txt`, `.md`, `.json`, `.py`, `.js` …) and the model reads them.
- **Voice** 🎙️ — one-shot speech-to-text (Groq Whisper), or a hands-free **📞 Call** mode that listens, answers and speaks back. Interrupt it any time by talking over it.
- **Spoken replies** 🔊 — Windows built-in voices (offline and free), or online voices via Groq. Arabic is supported in both.
- **Quick capture (Alt+Q)** ✨ — select text in any app, press Alt+Q, and get Summarize / Explain / Fix grammar / Translate, or ask about the selection.
- **Persistent memory** 🧠 — Orbit saves facts you tell it (your name, projects, preferences) and remembers them in future chats. You can review and delete them in *Settings → Memory*.
- **Multi-chat** 💬 — start new chats and revisit recent ones (up to 50 saved locally).
- **Streaming chat** with Markdown, code blocks, and a stop button.
- **Skills** — your own one-tap prompt shortcuts, shown as chips in chat.
- **MCP connectors** — stdio MCP servers run locally as child processes. Their tools are offered to the model automatically, and each tool call appears in chat as a status chip.
- **PC control** 🖱️ (optional, Windows) — see [PC control](#pc-control-️) below.
- Tray icon; can start minimized; keeps running in the tray when you close the window.

## Quick start

**Windows (easiest):** double-click **`start.bat`**. It installs dependencies on the first run, then launches the app. You need [Node.js](https://nodejs.org) (LTS).

Or from a terminal:

```bash
cd orbit-ai        # the folder you downloaded or cloned into
npm install        # first run downloads Electron (~100 MB)
npm start
```

1. Open the **Get Started** tab and follow the steps.
2. In **Connection**, paste a key:
   - Groq (free tier): https://console.groq.com/keys
   - OpenRouter: https://openrouter.ai/keys
   - NVIDIA: https://build.nvidia.com/settings/api-keys
3. Pick a model. The lists load live from the provider.
4. In **Floating Button**, click **Activate**. The orb appears. Drag it, click it, chat.

## Build the Windows installer

Double-click **`build-installer.bat`**, or run:

```bash
npm install
npm run dist           # → dist/OrbitAI-Setup-1.0.0.exe   (NSIS installer)
npm run dist:portable  # → dist/OrbitAI-Portable-1.0.0.exe (single portable exe)
```

The installer creates desktop and Start menu shortcuts and supports per-user install.

## Local AI (Hermes, Ollama, LM Studio…)

Orbit can chat with models running on your own PC — no internet, no cost.

1. Start a local server. For example, in Hermes Desktop: Settings → Providers → Local Models. This starts a llama.cpp server on `http://localhost:8080`.
2. In Orbit: **Connection → Local**, click a preset, then **Test connection**.
3. Pick the model in the *Default model* dropdown or the chat's model pill.

| Engine | Base URL preset |
|---|---|
| Hermes local models (llama.cpp) | `http://localhost:8080/v1` |
| Hermes Agent gateway | `http://localhost:8642/v1` |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |

Any OpenAI-compatible endpoint works. Paste its Base URL.

## MCP connectors

Any program with an MCP server can be a connector.

- **+ Add server**: for example, a game bridge with `node C:\mcp\my-bridge\index.js`.
- **⬇ Import from Claude / Cursor / VS Code**: reuses servers you already configured in `claude_desktop_config.json`, `.cursor/mcp.json`, or VS Code's `mcp.json`.
- **One-click templates**: Desktop Commander (files and terminal), Filesystem, Fetch (web), Memory.

`npx`-based servers need **Node.js**. `uvx`-based servers need **Python** and **uv**. You can find community servers for browsers, databases, Blender, Unity and more in the [MCP servers list](https://github.com/modelcontextprotocol/servers).

Notes:
- The model gets all *enabled* connectors' tools automatically.
- If a model doesn't support tools, Orbit notices and answers without them.

## PC control 🖱️

Enable it in **Connectors → 🖱️ PC control**. Orbit then gets 41 built-in Windows tools, including:

- Screenshots (full screen, per window, or a region), OCR of on-screen text, and vision-based clicking
- A virtual mouse and keyboard that act inside the target app without moving your physical cursor, plus the physical mouse and keyboard for hover-sensitive UI and games
- Reading, writing, searching, and recycle-bin deletion of files
- Listing, focusing, moving, resizing, and closing windows; launching apps and opening URLs
- Killing processes, clipboard access, notifications, volume and media keys, system stats, battery, network info, and a pixel color picker
- App discovery across the Start menu, desktop shortcuts, Store apps, installed programs, Steam libraries and Epic Games
- A raw PowerShell tool for anything else

**Safety.** In **confirm** mode (the default), every action shows an Allow/Deny card in chat before it runs. During voice calls, Orbit asks out loud, and you say "approve" or "deny." Read-only helpers (screen size, window list, battery) need no approval. **Full-auto** mode acts without asking. Use it only if you understand the risk. The AI's system prompt tells it to announce destructive actions, never type passwords or payment details, and do only what you asked. Those are instructions to the model, not hard guarantees. Always review what you approve.

Try: *"take a screenshot and tell me what you see, then open Notepad and type hello."*

## Privacy and security

- **Your API keys are encrypted on disk** using Windows' built-in protection (Electron `safeStorage`, which ties the encryption to your Windows user account). Keys are sent only to the provider you chose.
- **Settings and chats are stored locally** in your user data folder (`%APPDATA%\orbit-ai\config.json`). Orbit has no telemetry and no analytics. Its only network traffic goes to the providers you configure, to the search engines used by the `browser_search` tool, and to any MCP servers you add.
- **Prompt-injection hardening.** Content from files, web pages and tool output is treated as data, not as instructions to the model. This reduces risk but does not eliminate it. Keep PC control in confirm mode unless you have a reason not to.
- **Report a vulnerability:** see [SECURITY.md](SECURITY.md).

## Troubleshooting

- **"This model cannot see images"**: pick a model tagged 👁 in the picker, for example `meta-llama/llama-4-scout` on Groq, or a Gemini, Claude or GPT-4o model on OpenRouter.
- **`npm start` shows nothing or no window**: run `set ELECTRON_ENABLE_LOGGING=1` and then `npm start`, and read the console. You can also try `npm start -- --disable-gpu` to work around GPU driver problems. Startup errors appear in a dialog.
- **`npm install` fails**: usually the Electron download is blocked by a proxy, antivirus or VPN. Try `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` and run `npm install` again.
- **Hotkey does nothing**: another app owns `Alt+Space` (PowerToys Run, an IME, etc.). Change it under *Floating Button → Global hotkey*.
- **A connector fails to start**: check the error under the server's name. A missing Node.js is the usual cause for `npx` servers.
- **The orb is hidden in games**: exclusive-fullscreen games draw over everything. Set the game to borderless windowed.
- **Closing the window** keeps Orbit in the tray. Quit from the tray icon's menu.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Show or hide the floating button | `Alt+Space` (changeable; falls back to `Ctrl+Alt+Space`) |
| Quick capture on selected text | `Alt+Q` |
| Send in chat | `Enter` |
| New line | `Shift+Enter` |
| Orb menu | Right-click the orb |

## Project structure

```
orbit-ai/
├─ main/            Electron main process
│  ├─ main.js       windows, tray, hotkey, overlay drag, IPC
│  ├─ providers.js  Groq / OpenRouter / NVIDIA / local streaming client
│  ├─ agent.js      agent loop (stream → tool calls → final answer)
│  ├─ mcp.js        MCP manager (spawn, tools, call) and config import
│  ├─ pccontrol.js  Windows PC-control tools (approvals included)
│  ├─ tts.js        Windows and online voices
│  ├─ memory.js     persistent memory
│  ├─ store.js      JSON config store (encrypts API keys at rest)
│  └─ preload.js    secure IPC bridge
├─ renderer/        UI (plain HTML, CSS and JS, no framework)
│  ├─ main.html     dashboard: setup, keys, connectors, skills
│  ├─ chat.html     chat panel and model picker
│  └─ overlay.html  the floating orb
└─ icons/           app and tray icons (icon.ico is used by the installer)
```

## Contributing

Issues and pull requests are welcome. Please keep changes focused, and run `npm start` to test them before opening a PR.

## License

[MIT](LICENSE)

## Roadmap

- ✅ Local AI provider (Hermes, Ollama, LM Studio)
- ✅ Voice in and out (Groq Whisper and Windows voices)
- ✅ PC control (mouse, keyboard, windows, with approvals)
- ✅ Multi-chat and persistent memory
- ✅ Model picker with search, OpenRouter free models
- ✅ Voice-call approvals ("say approve or deny")
- 📦 Final installer polish

