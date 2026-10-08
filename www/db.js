// IndexedDB storage, two stores:
//   tracks {id, name, release?, position?, releaseId?}  (releaseId set when the song came from Discogs)
//   pairs  {id, from, to, rating, energy, notes}
const DB_NAME = 'mixpairs';
const DB_VERSION = 1;
const STORES = ['tracks', 'pairs'];

let dbPromise;

function openDb() {
  return dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) req.result.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// `fn` returns either an IDBRequest (resolves to its result) or a function called once the transaction commits.
async function withStores(names, mode, fn) {
  const conn = await openDb();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(names, mode);
    const out = fn(tx);
    tx.oncomplete = () => resolve(typeof out === 'function' ? out() : out?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const db = {
  all: store => withStores(store, 'readonly', tx => tx.objectStore(store).getAll()),
  // Resolves to the record's id (assigned by the store when the record has none).
  put: (store, value) => withStores(store, 'readwrite', tx => tx.objectStore(store).put(value)),
  // Resolves to the ids, in the same order as `rows`.
  putMany: (store, rows) => withStores(store, 'readwrite', tx => {
    const reqs = rows.map(r => tx.objectStore(store).put(r));
    return () => reqs.map(r => r.result);
  }),
  del: (store, id) => withStores(store, 'readwrite', tx => tx.objectStore(store).delete(id)),
  replaceAll: data => withStores(STORES, 'readwrite', tx => {
    for (const s of STORES) {
      const os = tx.objectStore(s);
      os.clear();
      for (const row of data[s]) os.put(row);
    }
  }),
};
