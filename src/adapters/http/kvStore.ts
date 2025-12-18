// Minimal browser KV store: IndexedDB first, fallback to localStorage, fallback to memory.

type KVGet = <T>(key: string) => Promise<T | undefined>
type KVSet = (key: string, value: any) => Promise<void>

export type KVStore = {
    get: KVGet
    set: KVSet
}

class SimpleIDB {
    private dbPromise: Promise<IDBDatabase> | null = null

    constructor(private dbName: string, private storeName: string) {
        if (typeof indexedDB === 'undefined') return
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
        if (!this.dbPromise) return undefined
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
        if (!this.dbPromise) return
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

function hasLocalStorage(): boolean {
    try {
        return typeof localStorage !== 'undefined'
    } catch {
        return false
    }
}

export function createKVStore(options?: { dbName?: string; storeName?: string; localStoragePrefix?: string }): KVStore {
    const dbName = options?.dbName ?? 'atoma-offline-db'
    const storeName = options?.storeName ?? 'queues'
    const prefix = options?.localStoragePrefix ?? 'atoma:kv:'

    const idb = new SimpleIDB(dbName, storeName)
    const memory = new Map<string, any>()
    const lsEnabled = hasLocalStorage()

    const get: KVGet = async (key) => {
        try {
            const v = await idb.get<any>(key)
            if (v !== undefined) return v
        } catch {
            // ignore and fallback
        }

        if (lsEnabled) {
            try {
                const raw = localStorage.getItem(prefix + key)
                if (raw) return JSON.parse(raw)
            } catch {
                // ignore
            }
        }

        return memory.get(key)
    }

    const set: KVSet = async (key, value) => {
        try {
            await idb.set(key, value)
            return
        } catch {
            // ignore and fallback
        }

        if (lsEnabled) {
            try {
                localStorage.setItem(prefix + key, JSON.stringify(value))
                return
            } catch {
                // ignore
            }
        }

        memory.set(key, value)
    }

    return { get, set }
}

