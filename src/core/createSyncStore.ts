import { atom } from 'jotai'
import { FindManyOptions, IAdapter, IStore, IndexDefinition, LifecycleHooks, SchemaValidator, StoreKey, UseFindManyResult } from './types'
import { initializeLocalStore } from './initializeLocalStore'
import { createUseValue } from '../hooks/useValue'
import { createUseAll } from '../hooks/useAll'
import { createUseFindMany } from '../hooks/useFindMany'
import { globalStore } from './BaseStore'

/**
 * Configuration for creating a sync store
 */
export interface SyncStoreConfig<T> {
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
    store?: ReturnType<typeof import('jotai').createStore>

    /** Optional schema validator (zod/yup/custom) */
    schema?: SchemaValidator<T>

    /** Lifecycle hooks for add/update */
    hooks?: LifecycleHooks<T>

    /** Index definitions */
    indexes?: Array<IndexDefinition<T>>
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
export function createSyncStore<T>(config: SyncStoreConfig<T>): SyncStore<T> {
    const { name, adapter, transformData } = config

    // Use custom store or fallback to globalStore
    const jotaiStore = config.store || globalStore

    // Create atom to hold the Map of items
    const objectMapAtom = atom(new Map<StoreKey, T>())

    // Initialize local store with adapter and Jotai store
    const localStore = initializeLocalStore(objectMapAtom, adapter, {
        transformData: transformData ? (item: T) => transformData(item) ?? item : undefined,
        idGenerator: config.idGenerator,
        store: jotaiStore,
        schema: config.schema,
        hooks: config.hooks,
        indexes: config.indexes
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
