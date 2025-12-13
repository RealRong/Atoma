import { atom } from 'jotai'
import { FindManyOptions, IAdapter, IStore, IndexDefinition, LifecycleHooks, SchemaValidator, StoreKey, UseFindManyResult, Entity, RelationMap, InferIncludeType, RelationConfig } from './types'
import type { DevtoolsBridge, StoreSnapshot } from '../devtools/types'
import { registerGlobalStore } from '../devtools/global'
import { initializeLocalStore } from './initializeLocalStore'
import { createUseValue } from '../hooks/useValue'
import { createUseAll } from '../hooks/useAll'
import { createUseFindMany } from '../hooks/useFindMany'
import { createUseMultiple, UseMultipleOptions } from '../hooks/useMultiple'
import { registerStoreAccess } from './storeAccessRegistry'
import { globalStore } from './BaseStore'
import { createStoreContext } from './StoreContext'
import type { JotaiStore } from './types'
import { getDefaultAdapterFactory } from './defaultAdapterFactory'

/**
 * Configuration for creating a sync store
 */
export interface SyncStoreConfig<T extends Entity> {
    /** Store name */
    name: string

    /** Storage adapter */
    adapter?: IAdapter<T>

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
    useValue: <Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        id?: StoreKey,
        options?: { include?: Include }
    ) => (keyof Include extends never ? T | undefined : any)

    /** React hook to subscribe to all items */
    useAll: <Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        options?: { include?: Include }
    ) => (keyof Include extends never ? T[] : any)

    /** React hook to run reactive queries */
    useFindMany: <Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        options?: FindManyOptions<T, Include> & {
            fetchPolicy?: import('./types').FetchPolicy
            include?: { [K in keyof Relations]?: InferIncludeType<Relations[K]> }
        }
    ) => UseFindManyResult<T, Relations, Include>

    /** React hook to subscribe to a list of IDs (顺序/排序可控) */
    useMultiple: <Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        ids: StoreKey[],
        options?: UseMultipleOptions<T, Relations> & { include?: Include }
    ) => (keyof Include extends never ? T[] : any)

    /** Get cached item without triggering fetch */
    getCachedOneById: (id: StoreKey) => T | undefined

    /** Get all cached items */
    getCachedAll: () => T[]

    /** 链式配置 relations，返回带新 Relations 类型的同一实例 */
    withRelations: <const NewRelations extends Record<string, RelationConfig<any, any>>>(factory: () => NewRelations) => SyncStore<T, NewRelations>
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
    const { name, transformData } = config

    const resolvedAdapter = (() => {
        if (config.adapter) return config.adapter
        const factory = getDefaultAdapterFactory()
        if (factory) return factory<T>(name)
        return undefined
    })()

    if (!resolvedAdapter) {
        throw new Error(`[Atoma] createSyncStore("${name}") 需要提供 adapter，或先调用 setDefaultAdapterFactory`)
    }

    // Use custom store or fallback to globalStore
    const jotaiStore = config.store || globalStore

    // Create per-store context with queue configuration (avoid runtime require to reduce cycles)
    const context = createStoreContext(config.queue)

    // Create atom to hold the Map of items
    const objectMapAtom = atom(new Map<StoreKey, T>())

    // Initialize local store with adapter, Jotai store, and context
    const localStore = initializeLocalStore(objectMapAtom, resolvedAdapter, {
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
    const useValue = createUseValue<T, Relations>(objectMapAtom, localStore as IStore<T, Relations>, jotaiStore)
    const useAll = createUseAll<T, Relations>(objectMapAtom, localStore as IStore<T, Relations>, jotaiStore)
    const useFindMany = createUseFindMany<T, Relations>(objectMapAtom, localStore as IStore<T, Relations>, jotaiStore)
    const useMultiple = createUseMultiple<T, Relations>(objectMapAtom, localStore as IStore<T, Relations>, jotaiStore)

    // 统一封装 relations 安装逻辑（懒加载，避免循环依赖）
    const applyRelations = (factory?: () => RelationMap<T>) => {
        if (!factory) return
        let cache: RelationMap<T> | undefined
        const getter = () => {
            if (!cache) cache = factory()
            return cache
        }
        Object.defineProperty(syncStore as any, '_relations', {
            get: getter,
            configurable: true
        })
        Object.defineProperty(localStore as any, '_relations', {
            get: getter,
            configurable: true
        })
    }

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
        useMultiple,
        _relations: undefined,

        getCachedOneById: (id: StoreKey) => {
            return jotaiStore.get(objectMapAtom).get(id)
        },

        getCachedAll: () => {
            return Array.from(jotaiStore.get(objectMapAtom).values())
        },

        withRelations: <NewRelations extends Record<string, import('./types').RelationConfig<any, any>>>(factory: () => NewRelations) => {
            applyRelations(factory)
            return syncStore as unknown as SyncStore<T, NewRelations>
        }
    }

    // Apply lazy relations getter if provided
    applyRelations(getRelations)

    // 内部注册 atom / jotaiStore，供 useRelations 订阅（不暴露到公共 API）
    registerStoreAccess(localStore as any, objectMapAtom, jotaiStore)
    registerStoreAccess(syncStore as any, objectMapAtom, jotaiStore)

    return syncStore
}

// Legacy alias
export const createStore = createSyncStore
