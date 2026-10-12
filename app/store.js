// Everything the app keeps lives in IndexedDB on the phone: finished and
// unfinished games, optional test recordings, and settings.

const DB = 'squarecast';
const VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const games = {
  put: (game) => tx('games', 'readwrite', (s) => s.put(game)),
  get: (id) => tx('games', 'readonly', (s) => s.get(id)),
  all: () => tx('games', 'readonly', (s) => s.getAll()),
  remove: (id) => tx('games', 'readwrite', (s) => s.delete(id)),
};

export const recordings = {
  put: (rec) => tx('recordings', 'readwrite', (s) => s.put(rec)),
  get: (id) => tx('recordings', 'readonly', (s) => s.get(id)),
  remove: (id) => tx('recordings', 'readwrite', (s) => s.delete(id)),
  keys: () => tx('recordings', 'readonly', (s) => s.getAllKeys()),
};

export const settings = {
  get: (key, fallback) => tx('settings', 'readonly', (s) => s.get(key)).then((v) => (v === undefined ? fallback : v)),
  set: (key, value) => tx('settings', 'readwrite', (s) => s.put(value, key)),
};

// Ask the browser not to clear our data when space runs low.
export async function persist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch {
    // Not supported; nothing to do.
  }
  return false;
}
