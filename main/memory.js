// Persistent memory about the user — saved locally, injected into every chat.
// The AI saves/forgets facts via tools; the user sees & manages them in Settings.
const TOOLS = [
  {
    name: 'memory_save', approval: false,
    description: 'Save a lasting fact about the user (their name, preferences, ongoing projects, games they play, how they like answers). Use whenever the user shares something personal worth remembering across chats. Max ~200 chars, one fact per save.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'memory_list', approval: false,
    description: 'List everything you currently remember about the user.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'memory_forget', approval: false,
    description: 'Delete memory/ies matching part of the given text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  }
];

class Memory {
  constructor(store) {
    this.store = store;
  }

  all() {
    return this.store.get('memories', []);
  }

  save(list) {
    this.store.set('memories', list.slice(0, 100));
  }

  openAiTools() {
    return TOOLS.map((t) => ({
      serverId: '__mem',
      originalName: t.name,
      name: 'mem__' + t.name,
      description: '[Memory] ' + t.description,
      inputSchema: t.parameters
    }));
  }

  async call(fullName, args, _opts = {}) {
    const action = String(fullName || '').replace(/^mem__/, '');
    args = args || {};

    if (action === 'memory_save') {
      const text = String(args.text || '').trim().slice(0, 200);
      if (!text) return { text: 'Nothing to remember (empty).' };
      const list = this.all();
      if (list.some((m) => m.text.toLowerCase() === text.toLowerCase())) {
        return { text: 'Already remembered.' };
      }
      list.unshift({ id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, ts: Date.now() });
      this.save(list);
      return { text: `Remembered: "${text}" (${this.all().length} memories total).` };
    }

    if (action === 'memory_list') {
      const list = this.all();
      if (!list.length) return { text: 'You have no memories about the user yet.' };
      return { text: 'Memories about the user:\n' + list.map((m) => `- [${m.id}] ${m.text}`).join('\n') };
    }

    if (action === 'memory_forget') {
      const q = String(args.text || '').toLowerCase();
      const list = this.all();
      const kept = list.filter((m) => !m.text.toLowerCase().includes(q));
      this.save(kept);
      const removed = list.length - kept.length;
      return { text: removed ? `Forgot ${removed} memory(ies).` : 'No memory matched that text.' };
    }

    return { text: 'Unknown memory action.' };
  }
}

module.exports = { Memory };
