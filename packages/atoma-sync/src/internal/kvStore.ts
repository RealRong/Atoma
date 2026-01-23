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
const DB_VERSION = 2
const DEFAULT_STORE_NAME = 'sync'
const OUTBOX_STORE_NAME = 'outbox_entries'

function ensureSchema(db: any, storeName: string) {
    if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName)
    }
    // Ensure the outbox objectStore exists as well; see `store.ts`.
    if (!db.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
        const store = db.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'pk' })
        store.createIndex('by_outbox', 'outboxKey')
        store.createIndex('by_outbox_status_enqueued', ['outboxKey', 'status', 'enqueuedAtMs'])
        store.createIndex('by_outbox_status_inFlightAt', ['outboxKey', 'status', 'inFlightAtMs'])
        store.createIndex('by_outbox_status_resource_entity_enqueued', ['outboxKey', 'status', 'resource', 'entityId', 'enqueuedAtMs'])
    }
}

export function createKVStore(options?: { dbName?: string; storeName?: string }): KVStore {
    const dbName = options?.dbName ?? 'atoma-sync-db'
    const storeName = options?.storeName ?? DEFAULT_STORE_NAME

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

    const dbPromise = openDB(dbName, DB_VERSION, {
        upgrade(db) {
            ensureSchema(db as any, storeName)
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
