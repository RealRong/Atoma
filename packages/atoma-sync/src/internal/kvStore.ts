// Minimal KV store for Sync persistence:
// - Browser: IndexedDB (via `idb`)
// - Non-browser (no indexedDB): in-memory fallback (non-durable, mainly for Node/tests)
//
// We intentionally keep the API tiny but include `update()` for lock-like atomic RMW.
import { openDB } from 'idb'

type KVGet = <T>(key: string) => Promise<T | undefined>
type KVSet = (key: string, value: any) => Promise<void>

export type KVUpdateFn<T> = (current: any | undefined) => Readonly<{
    result: T
    next?: any
    write?: boolean
}>

export type KVUpdate = <T>(key: string, fn: KVUpdateFn<T>) => Promise<T>

export type KVStore = {
    get: KVGet
    set: KVSet
    update: KVUpdate
}

const KV_STORE_CACHE = new Map<string, KVStore>()

export function createKVStore(options?: { dbName?: string; storeName?: string }): KVStore {
    const dbName = options?.dbName ?? 'atoma-sync-db'
    const storeName = options?.storeName ?? 'sync'

    const cacheKey = `${dbName}::${storeName}`
    const cached = KV_STORE_CACHE.get(cacheKey)
    if (cached) return cached

    if (typeof indexedDB === 'undefined') {
        const memory = new Map<string, any>()

        const get: KVGet = async (key) => {
            return memory.get(key)
        }

        const set: KVSet = async (key, value) => {
            memory.set(key, value)
        }

        const update: KVUpdate = async (key, fn) => {
            const current = memory.get(key)
            const out = fn(current)
            if (out.write !== false) {
                memory.set(key, out.next)
            }
            return out.result
        }

        const store: KVStore = { get, set, update }
        KV_STORE_CACHE.set(cacheKey, store)
        return store
    }

    const dbPromise = openDB(dbName, 1, {
        upgrade(db) {
            if (!db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName)
            }
        }
    })

    const get: KVGet = async (key) => {
        const db = await dbPromise
        return db.get(storeName, key) as any
    }

    const set: KVSet = async (key, value) => {
        const db = await dbPromise
        await db.put(storeName, value, key)
    }

    const update: KVUpdate = async (key, fn) => {
        const db = await dbPromise
        const tx = db.transaction(storeName, 'readwrite')
        const current = await tx.store.get(key)
        const out = fn(current)
        if (out.write !== false) {
            await tx.store.put(out.next, key)
        }
        await tx.done
        return out.result
    }

    const store: KVStore = { get, set, update }
    KV_STORE_CACHE.set(cacheKey, store)
    return store
}
