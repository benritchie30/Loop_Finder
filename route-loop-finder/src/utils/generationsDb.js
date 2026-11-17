/**
 * Generations saved in the browser (IndexedDB): every route, settings, pins,
 * and painted roads, kept until deleted. A route is ~100 KB, so this is far
 * beyond what localStorage holds. Favorite routes are a store of their own
 * (a copy of each route, keyed by utils/routeIdentity), so they outlive the
 * generation they came from. Every function resolves even when storage is
 * unavailable (private windows, blocked storage): the app then works for the
 * session without saving.
 */
const DB_NAME = 'loop-finder';
const STORE = 'generations';
const HEADS = 'generationHeads';
const FAVORITES = 'favorites';
const VERSION = 3; // 2: favorites; 3: generation heads (no longer used: see loadGenerations)

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
            // Unused now, kept so a browser that has version 3 opens the same way.
            if (!db.objectStoreNames.contains(HEADS)) db.createObjectStore(HEADS, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(FAVORITES)) db.createObjectStore(FAVORITES, { keyPath: 'key' });
        };
        req.onsuccess = () => {
            const db = req.result;
            // Another tab opening a newer version: let it upgrade.
            db.onversionchange = () => db.close();
            resolve(db);
        };
        req.onblocked = () => console.warn('[generationsDb] waiting for another tab to close the old version');
        req.onerror = () => {
            console.warn('[generationsDb] storage unavailable:', req.error);
            resolve(null);
        };
    });
    return dbPromise;
}

function run(mode, work, storeName = STORE) {
    return openDb().then((db) => new Promise((resolve) => {
        if (!db) {
            resolve(null);
            return;
        }
        try {
            const tx = db.transaction(storeName, mode);
            const result = work(tx.objectStore(storeName));
            tx.oncomplete = () => resolve(result?.result ?? true);
            tx.onerror = () => {
                console.warn('[generationsDb]', tx.error);
                resolve(null);
            };
            tx.onabort = () => {
                console.warn('[generationsDb] aborted:', tx.error);
                resolve(null);
            };
        } catch (err) {
            console.warn('[generationsDb]', err);
            resolve(null);
        }
    }));
}

const HEAD_FIELDS = ['name', 'createdAt', 'markerPosition', 'settings', 'selections', 'batches', 'lastNote'];

/**
 * Every saved generation, routes included (unordered).
 * For a short while generations also had a small "head" record (so routes
 * could be read only when one was opened), and a rename or a painted road on
 * a closed generation was written to the head alone. Any head left is put
 * back into its generation here, once, and the heads are cleared.
 */
export async function loadGenerations() {
    const [rows, heads] = await Promise.all([
        run('readonly', (store) => store.getAll()),
        run('readonly', (store) => store.getAll(), HEADS),
    ]);
    const records = Array.isArray(rows) ? rows : [];
    if (!Array.isArray(heads) || !heads.length) return records;
    const byId = new Map(heads.map((h) => [h.id, h]));
    const merged = records.map((record) => {
        const head = byId.get(record.id);
        if (!head) return record;
        const next = { ...record };
        HEAD_FIELDS.forEach((key) => { if (key in head) next[key] = head[key]; });
        const changed = HEAD_FIELDS.some((key) => JSON.stringify(next[key]) !== JSON.stringify(record[key]));
        if (changed) saveGeneration(next);
        return changed ? next : record;
    });
    await run('readwrite', (store) => store.clear(), HEADS);
    return merged;
}

/** Save (insert or replace) one generation record. */
export function saveGeneration(record) {
    return run('readwrite', (store) => store.put(record));
}

export function deleteGeneration(id) {
    return run('readwrite', (store) => store.delete(id));
}

/** Every favorite route: [{ key, path, pathSetId, setName, start, createdAt }]. */
export function loadFavorites() {
    return run('readonly', (store) => store.getAll(), FAVORITES).then((rows) => (Array.isArray(rows) ? rows : []));
}

export function saveFavorite(record) {
    return run('readwrite', (store) => store.put(record), FAVORITES);
}

export function deleteFavorite(key) {
    return run('readwrite', (store) => store.delete(key), FAVORITES);
}
