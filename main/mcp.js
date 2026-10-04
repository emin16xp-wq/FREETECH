// MCP (Model Context Protocol) connector manager.
// Spawns stdio MCP servers, aggregates their tools, and exposes them to the LLM.
// Compatible with servers from Claude Desktop, Cursor, VS Code and anywhere else.

const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CONNECT_TIMEOUT_MS = 25000;

function sanitizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'server';
}

// One-click connector templates (all are real, public MCP servers).
const TEMPLATES = [
  {
    name: 'Desktop Commander — files & terminal',
    description: 'Read/write files, run commands, control apps on this PC.',
    command: 'npx',
    args: ['-y', '@wonderwhy-er/desktop-commander'],
    env: {}
  },
  {
    name: 'Filesystem — folder access',
    description: 'Read/write files inside one folder you allow.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\Public'],
    env: {}
  },
  {
    name: 'Fetch — web pages',
    description: 'Fetch a URL and turn it into markdown for the AI.',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: {}
  },
  {
    name: 'Memory — persistent knowledge',
    description: 'A knowledge graph the assistant can remember across chats.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {}
  },
];

// Well-known MCP config files we can import (Claude Desktop, Cursor, VS Code, etc.)
function knownConfigPaths() {
  const home = os.homedir();
  const list = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    list.push(path.join(appData, 'Claude', 'claude_desktop_config.json'));
    list.push(path.join(home, '.cursor', 'mcp.json'));
    list.push(path.join(appData, 'Code', 'User', 'mcp.json'));
  } else if (process.platform === 'darwin') {
    list.push(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    list.push(path.join(home, '.cursor', 'mcp.json'));
    list.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'));
  } else {
    list.push(path.join(home, '.config', 'Claude', 'claude_desktop_config.json'));
    list.push(path.join(home, '.cursor', 'mcp.json'));
    list.push(path.join(home, '.config', 'Code', 'User', 'mcp.json'));
  }
  return list;
}

// Parse any MCP-style config file → [{ name, command, args, env, source }]
function parseMcpConfigFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const map = raw.mcpServers || raw.servers || (raw.mcp && raw.mcp.servers) || null;
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .filter(([, v]) => v && (v.command || v.url || v.type === 'stdio'))
    .map(([name, v]) => ({
      name,
      command: v.command || '',
      args: Array.isArray(v.args) ? v.args : [],
      env: v.env && typeof v.env === 'object' ? v.env : {},
      source: path.basename(filePath)
    }))
    .filter((s) => s.command); // stdio servers only for now
}

class McpManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.connections = new Map(); // id -> { client, transport, tools }
  }

  getServers() {
    return this.store.get('mcpServers', []);
  }

  saveServers(servers) {
    this.store.set('mcpServers', servers);
    this.emit('changed');
  }

  // On Windows, npm/npx/uvx are .cmd shims — spawn through cmd.exe.
  resolveSpawn(command, args) {
    if (process.platform === 'win32') {
      const bare = path.basename(command).replace(/\.(cmd|bat|exe)$/i, '').toLowerCase();
      if (['npx', 'npm', 'pnpm', 'yarn', 'pnpx', 'uvx', 'uv'].includes(bare) || /\.(cmd|bat)$/i.test(command)) {
        return { command: 'cmd', args: ['/c', command, ...args] };
      }
    }
    return { command, args };
  }

  summary(id) {
    const s = this.getServers().find((x) => x.id === id);
    if (!s) return null;
    const conn = this.connections.get(id);
    return {
      id: s.id,
      name: s.name,
      command: s.command,
      args: s.args,
      env: s.env,
      enabled: !!s.enabled,
      status: s.status || 'stopped',
      error: s.error || '',
      tools: conn
        ? conn.tools.map((t) => ({ name: t.name, description: t.description || '' }))
        : []
    };
  }

  listSummaries() {
    return this.getServers().map((s) => this.summary(s.id)).filter(Boolean);
  }

  setStatus(id, status, error = '') {
    const servers = this.getServers();
    const s = servers.find((x) => x.id === id);
    if (!s) return;
    s.status = status;
    s.error = error;
    this.store.set('mcpServers', servers);
    this.emit('changed');
  }

  async add({ name, command, args, env, enabled = false }) {
    const servers = this.getServers();
    const id = sanitizeName(name) + '_' + Math.random().toString(36).slice(2, 6);
    servers.push({ id, name, command, args: args || [], env: env || {}, enabled, status: 'stopped', error: '' });
    this.saveServers(servers);
    if (enabled) await this.connect(id).catch(() => {});
    return this.summary(id);
  }

  async update(id, patch) {
    const servers = this.getServers();
    const s = servers.find((x) => x.id === id);
    if (!s) throw new Error('Server not found');
    const needsReconnect = ['command', 'args', 'env'].some(
      (k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(s[k])
    );
    Object.assign(s, patch);
    this.saveServers(servers);
    if (needsReconnect) {
      await this.disconnect(id);
      if (s.enabled) await this.connect(id).catch(() => {});
    }
    return this.summary(id);
  }

  async remove(id) {
    await this.disconnect(id);
    this.saveServers(this.getServers().filter((x) => x.id !== id));
  }

  async toggle(id, enabled) {
    const servers = this.getServers();
    const s = servers.find((x) => x.id === id);
    if (!s) throw new Error('Server not found');
    s.enabled = !!enabled;
    this.saveServers(servers);
    if (enabled) await this.connect(id).catch(() => {});
    else await this.disconnect(id);
    return this.summary(id);
  }

  async connect(id) {
    const s = this.getServers().find((x) => x.id === id);
    if (!s) throw new Error('Server not found');
    if (this.connections.has(id)) return this.summary(id);

    const { command, args } = this.resolveSpawn(s.command, s.args || []);
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...(s.env || {}) },
      stderr: 'pipe'
    });

    const client = new Client({ name: 'Orbit AI', version: '1.0.0' });
    this.setStatus(id, 'connecting');

    const onClosed = () => {
      if (this.connections.has(id)) {
        this.connections.delete(id);
        this.setStatus(id, 'stopped');
      }
    };
    transport.onclose = onClosed;
    transport.onerror = (err) => {
      const servers = this.getServers().find((x) => x.id === id);
      if (servers) this.setStatus(id, 'error', String(err.message || err));
    };

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      let tools = [];
      try {
        const res = await client.listTools();
        tools = res.tools || [];
      } catch {
        tools = [];
      }
      this.connections.set(id, { client, transport, tools });
      this.setStatus(id, 'connected');
    } catch (e) {
      this.setStatus(id, 'error', String(e.message || e));
      try {
        await transport.close();
      } catch {}
      throw e;
    }
    return this.summary(id);
  }

  async disconnect(id) {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    try {
      await conn.transport.close();
    } catch {}
    this.setStatus(id, 'stopped');
  }

  async disconnectAll() {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  // All tools from connected+enabled servers, in OpenAI function-calling format.
  openAiTools() {
    const out = [];
    for (const s of this.getServers()) {
      if (!s.enabled) continue;
      const conn = this.connections.get(s.id);
      if (!conn) continue;
      const prefix = sanitizeName(s.id.split('_')[0]);
      for (const t of conn.tools) {
        const name = `${prefix}__${sanitizeName(t.name)}`.slice(0, 64);
        out.push({
          serverId: s.id,
          originalName: t.name,
          name,
          description: `[${s.name}] ${t.description || t.name}`.slice(0, 1024),
          inputSchema: t.inputSchema || { type: 'object', properties: {} }
        });
      }
    }
    return out;
  }

  findTool(name) {
    return this.openAiTools().find((t) => t.name === name) || null;
  }

  async callTool(fullName, args) {
    const tool = this.findTool(fullName);
    if (!tool) throw new Error(`Unknown tool: ${fullName}`);
    const conn = this.connections.get(tool.serverId);
    if (!conn) throw new Error(`Server for ${fullName} is not connected`);
    const result = await conn.client.callTool({ name: tool.originalName, arguments: args || {} });
    return result;
  }
}

function toolResultToText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (result.isError) {
    const t = Array.isArray(result.content)
      ? result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
      : JSON.stringify(result);
    return 'Tool error: ' + t;
  }
  if (Array.isArray(result.content)) {
    return result.content
      .map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return '[image returned]';
        if (c.type === 'resource') return '[resource returned]';
        return JSON.stringify(c).slice(0, 2000);
      })
      .join('\n');
  }
  return JSON.stringify(result);
}

module.exports = { McpManager, TEMPLATES, knownConfigPaths, parseMcpConfigFile, toolResultToText, sanitizeName };
