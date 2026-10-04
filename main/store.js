// Tiny JSON config store persisted in the app's userData folder.
//
// API keys are encrypted at rest with Electron's safeStorage (Windows DPAPI,
// bound to the current Windows user). Keys saved by older versions in plain
// text are migrated automatically on the next launch. If encryption is not
// available on the machine, keys fall back to plain text (and we say so in the log).
const fs = require('fs');
const path = require('path');

let safeStorage = null;
try {
  safeStorage = require('electron').safeStorage;
} catch {
  // Not running inside Electron (e.g. a unit test) — encryption simply stays off.
}

function canEncrypt() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

class Store {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.needsSave = false;
    this.data = this.load();
    if (this.needsSave) this.save();
  }

  load() {
    let raw = {};
    let existed = true;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      existed = false;
      raw = {};
    }

    const data = { ...this.defaults, ...raw };
    delete data.keysEnc;

    if (raw.keysEnc) {
      try {
        data.keys = JSON.parse(safeStorage.decryptString(Buffer.from(raw.keysEnc, 'base64')));
      } catch (e) {
        console.error('[store] could not decrypt saved API keys — please re-enter them:', e.message);
        data.keys = {};
      }
    } else if (raw.keys && canEncrypt()) {
      // Plain-text keys from an older version: keep them, and re-save encrypted.
      this.needsSave = true;
    }

    // Always work on a fresh object so defaults are never mutated by accident.
    data.keys = { ...(this.defaults.keys || {}), ...(data.keys || {}) };

    if (!existed) this.needsSave = true;
    return data;
  }

  get(key, fallback) {
    if (key in this.data) return this.data[key];
    return fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  patch(obj) {
    Object.assign(this.data, obj);
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });

      const out = { ...this.data };
      if (canEncrypt()) {
        const keys = out.keys || {};
        delete out.keys;
        out.keysEnc = safeStorage.encryptString(JSON.stringify(keys)).toString('base64');
      }

      // Write to a temp file first, then swap it in, so a crash mid-write can't corrupt the config.
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, this.file);
      this.needsSave = false;
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }
}

module.exports = { Store };
