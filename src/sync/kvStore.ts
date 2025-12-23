// Minimal IndexedDB-only KV store (required for Sync persistence).

type KVGet = <T>(key: string) => Promise<T | undefined>
type KVSet = (key: string, value: any) => Promise<void>

export type KVStore = {
    get: KVGet
    set: KVSet
}

const KV_STORE_CACHE = new Map<string, KVStore>()

class StrictIDB {
    private dbPromise: Promise<IDBDatabase>

    constructor(private dbName: string, private storeName: string) {
        if (typeof indexedDB === 'undefined') {
            throw new Error('[Sync] indexedDB is not available')
        }
        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve(request.result)
            request.onupgradeneeded = () => {
                const db = request.result
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName)
                }
            }
        })
    }

    async get<T>(key: string): Promise<T | undefined> {
        const db = await this.dbPromise
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly')
            const store = tx.objectStore(this.storeName)
            const req = store.get(key)
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        })
    }

    async set(key: string, value: any): Promise<void> {
        const db = await this.dbPromise
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite')
            const store = tx.objectStore(this.storeName)
            const req = store.put(value, key)
            req.onsuccess = () => resolve()
            req.onerror = () => reject(req.error)
        })
    }
}

export function createKVStore(options?: { dbName?: string; storeName?: string }): KVStore {
    const dbName = options?.dbName ?? 'atoma-sync-db'
    const storeName = options?.storeName ?? 'sync'

    const cacheKey = `${dbName}::${storeName}`
    const cached = KV_STORE_CACHE.get(cacheKey)
    if (cached) return cached

    const idb = new StrictIDB(dbName, storeName)

    const get: KVGet = async (key) => {
        return idb.get<any>(key)
    }

    const set: KVSet = async (key, value) => {
        await idb.set(key, value)
    }

    const store: KVStore = { get, set }
    KV_STORE_CACHE.set(cacheKey, store)
    return store
}
