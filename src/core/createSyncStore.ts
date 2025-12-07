import { atom } from 'jotai'
import { FindManyOptions, IAdapter, IStore, IndexDefinition, LifecycleHooks, SchemaValidator, StoreKey, UseFindManyResult, Entity } from './types'
import { initializeLocalStore } from './initializeLocalStore'
import { createUseValue } from '../hooks/useValue'
import { createUseAll } from '../hooks/useAll'
import { createUseFindMany } from '../hooks/useFindMany'
import { globalStore } from './BaseStore'
import { createStoreContext } from './StoreContext'
import type { JotaiStore } from './types'

/**
 * Configuration for creating a sync store
 */
export interface SyncStoreConfig<T extends Entity> {
    /** Store name */
    name: string

    /** Storage adapter */
    adapter: IAdapter<T>

    /** Transform data on read from adapter */
    transformData?: (data: T) => T | undefined

    /** Custom ID generator (defaults to Snowflake-like generator) */
    idGenerator?: () => StoreKey

    /** Custom Jotai store (optional, defaults to globalStore) */
    /** Use this for SSR to create per-request isolated stores */
    store?: JotaiStore

    /** Optional schema validator (zod/yup/custom) */
    schema?: SchemaValidator<T>

    /** Lifecycle hooks for add/update */
    hooks?: LifecycleHooks<T>

    /** Index definitions */
    indexes?: Array<IndexDefinition<T>>

    /** Queue configuration (per-store override) */
    queue?: Partial<import('./types').QueueConfig>
}

/**
 * Sync store instance
 */
export interface SyncStore<T> extends IStore<T> {
    /** React hook to subscribe to single item */
    useValue: (id?: StoreKey) => T | undefined

    /** React hook to subscribe to all items */
    useAll: () => T[]

    /** React hook to run reactive queries */
    useFindMany: (options?: FindManyOptions<T>) => UseFindManyResult<T>

    /** Get cached item without triggering fetch */
    getCachedOneById: (id: StoreKey) => T | undefined

    /** Get all cached items */
    getCachedAll: () => T[]
}

/**
 * Create a new sync store
 */
export function createSyncStore<T extends Entity>(config: SyncStoreConfig<T>): SyncStore<T> {
    const { name, adapter, transformData } = config

    // Use custom store or fallback to globalStore
    const jotaiStore = config.store || globalStore

    // Create per-store context with queue configuration (avoid runtime require to reduce cycles)
    const context = createStoreContext(config.queue)

    // Create atom to hold the Map of items
    const objectMapAtom = atom(new Map<StoreKey, T>())

    // Initialize local store with adapter, Jotai store, and context
    const localStore = initializeLocalStore(objectMapAtom, adapter, {
        transformData: transformData ? (item: T) => transformData(item) ?? item : undefined,
        idGenerator: config.idGenerator,
        store: jotaiStore,
        schema: config.schema,
        hooks: config.hooks,
        indexes: config.indexes,
        context  // Pass context to initializeLocalStore
    })

    // Create React hooks with custom store
    const useValue = createUseValue(objectMapAtom, localStore, jotaiStore)
    const useAll = createUseAll(objectMapAtom, jotaiStore)
    const useFindMany = createUseFindMany(objectMapAtom, localStore, jotaiStore)

    // Create sync store with all methods
    const syncStore: SyncStore<T> = {
        ...localStore,
        useValue,
        useAll,
        useFindMany,

        getCachedOneById: (id: StoreKey) => {
            return jotaiStore.get(objectMapAtom).get(id)
        },

        getCachedAll: () => {
            return Array.from(jotaiStore.get(objectMapAtom).values())
        }
    }

    return syncStore
}

// Legacy alias
export const createStore = createSyncStore
