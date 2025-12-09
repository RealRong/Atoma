import { atom } from 'jotai'
import { FindManyOptions, IAdapter, IStore, IndexDefinition, LifecycleHooks, SchemaValidator, StoreKey, UseFindManyResult, Entity, RelationMap } from './types'
import type { DevtoolsBridge, StoreSnapshot } from '../devtools/types'
import { registerGlobalStore } from '../devtools/global'
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

    /** Devtools bridge（可选） */
    devtools?: DevtoolsBridge
}

/**
 * Sync store instance
 */
export interface SyncStore<T, Relations extends RelationMap<T> = {}> extends IStore<T, Relations> {
    /** React hook to subscribe to single item */
    useValue: (id?: StoreKey) => T | undefined

    /** React hook to subscribe to all items */
    useAll: () => T[]

    /** React hook to run reactive queries */
    useFindMany: <Include extends Partial<Record<keyof Relations, any>> = {}>(options?: FindManyOptions<T, Include>) => UseFindManyResult<T, Relations, Include>

    /** Get cached item without triggering fetch */
    getCachedOneById: (id: StoreKey) => T | undefined

    /** Get all cached items */
    getCachedAll: () => T[]
}

/**
 * Create a new sync store
 */
// 重载：传入 relations 时捕获精确键
export function createSyncStore<T extends Entity, const Relations extends RelationMap<T>>(
    config: SyncStoreConfig<T> & { relations: () => Relations }
): SyncStore<T, Relations>

// 重载：relations 可选（无则 Relations 默认为 {}）
export function createSyncStore<T extends Entity, const Relations extends RelationMap<T> = {}>(
    config: SyncStoreConfig<T> & { relations?: () => Relations }
): SyncStore<T, Relations>

export function createSyncStore<T extends Entity, Relations extends RelationMap<T> = {}>(
    config: SyncStoreConfig<T> & { relations?: () => Relations }
): SyncStore<T, Relations> {
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
        context,  // Pass context to initializeLocalStore
        devtools: config.devtools,
        storeName: name
    }) as IStore<T>

    // Create React hooks with custom store
    const useValue = createUseValue(objectMapAtom, localStore, jotaiStore)
    const useAll = createUseAll(objectMapAtom, jotaiStore)
    const useFindMany = createUseFindMany<T, Relations>(objectMapAtom, localStore as IStore<T, Relations>, jotaiStore)

    // Devtools snapshot注册
    const snapshot = (): StoreSnapshot => {
        const map = jotaiStore.get(objectMapAtom)
        const sample: T[] = Array.from(map.values()).slice(0, 5)
        const approxSize = (() => {
            try {
                const str = JSON.stringify(sample)
                return str ? str.length * 2 : 0
            } catch {
                return 0
            }
        })()
        return {
            name,
            count: map.size,
            approxSize,
            sample,
            timestamp: Date.now()
        }
    }
    const stopDevtools = config.devtools?.registerStore?.({ name, snapshot })
        ?? registerGlobalStore({ name, snapshot })

    // Lazy resolver for relations（延迟求值避免循环依赖）
    const getRelations = (() => {
        const relationsFactory = config.relations
        if (!relationsFactory) return undefined
        if (typeof relationsFactory !== 'function') {
            throw new Error('[Atoma] config.relations 必须是返回 RelationMap 的函数')
        }
        let cache: Relations | undefined
        return () => {
            if (!cache) {
                cache = relationsFactory() as Relations
            }
            return cache
        }
    })()

    // Create sync store with all methods
    const syncStore: SyncStore<T, Relations> = {
        ...localStore,
        useValue,
        useAll,
        useFindMany,
        _relations: undefined,

        getCachedOneById: (id: StoreKey) => {
            return jotaiStore.get(objectMapAtom).get(id)
        },

        getCachedAll: () => {
            return Array.from(jotaiStore.get(objectMapAtom).values())
        }
    }

    // Apply lazy relations getter if provided
    if (getRelations) {
        Object.defineProperty(syncStore, '_relations', {
            get: getRelations,
            configurable: true
        })
        Object.defineProperty(localStore as any, '_relations', {
            get: getRelations,
            configurable: true
        })
    }

    return syncStore
}

// Legacy alias
export const createStore = createSyncStore
