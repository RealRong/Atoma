import { atom } from 'jotai/vanilla'
import type { DevtoolsBridge, StoreSnapshot } from '../devtools/types'
import { getGlobalDevtools, registerGlobalStore } from '../devtools/global'
import { createStoreRuntime } from './store/runtime'
import { createAddOne } from './store/addOne'
import { createBatchGet } from './store/batchGet'
import { createDeleteOneById } from './store/deleteOneById'
import { createFindMany } from './store/findMany/index'
import { createGetAll } from './store/getAll'
import { createGetMultipleByIds } from './store/getMultipleByIds'
import { createUpdateOne } from './store/updateOne'
import { registerStoreAccess, resolveStoreAccess } from './storeAccessRegistry'
import { globalStore } from './BaseStore'
import { createStoreContext } from './StoreContext'
import type { JotaiStore } from './types'
import { getDefaultAdapterFactory } from './defaultAdapterFactory'
import type { DebugConfig } from '../observability/types'
import type { DebugEvent } from '../observability/types'
import type {
    Entity,
    IAdapter,
    IStore,
    IndexDefinition,
    LifecycleHooks,
    RelationConfig,
    RelationMap,
    SchemaValidator,
    StoreKey
} from './types'

export interface CoreStoreConfig<T extends Entity> {
    name: string
    adapter?: IAdapter<T>
    transformData?: (data: T) => T | undefined
    idGenerator?: () => StoreKey
    store?: JotaiStore
    schema?: SchemaValidator<T>
    hooks?: LifecycleHooks<T>
    indexes?: Array<IndexDefinition<T>>
    queue?: Partial<import('./types').QueueConfig>
    devtools?: DevtoolsBridge
    debug?: DebugConfig
}

export interface CoreStore<T extends Entity, Relations = {}> extends IStore<T, Relations> {
    name: string
    getCachedOneById: (id: StoreKey) => T | undefined
    getCachedAll: () => T[]
    withRelations: <const NewRelations extends Record<string, RelationConfig<any, any>>>(factory: () => NewRelations) => CoreStore<T, NewRelations>
}

export function createCoreStore<T extends Entity, const Relations>(
    config: CoreStoreConfig<T> & { relations: () => Relations }
): CoreStore<T, Relations>

export function createCoreStore<T extends Entity, const Relations = {}>(
    config: CoreStoreConfig<T> & { relations?: () => Relations }
): CoreStore<T, Relations>

export function createCoreStore<T extends Entity, Relations = {}>(
    config: CoreStoreConfig<T> & { relations?: () => Relations }
): CoreStore<T, Relations> {
    const { name, transformData } = config
    const resolvedDebug: DebugConfig | undefined = config.debug
    const debugSink: ((e: DebugEvent) => void) | undefined = resolvedDebug?.enabled
        ? (e) => {
            const bridge = config.devtools ?? getGlobalDevtools()
            try {
                bridge?.emit({ type: 'debug-event', payload: e as any })
            } catch {
                // ignore
            }
        }
        : undefined

    const resolvedAdapter = (() => {
        if (config.adapter) return config.adapter
        const factory = getDefaultAdapterFactory()
        if (factory) return factory<T>(name)
        return undefined
    })()

    if (!resolvedAdapter) {
        throw new Error(`[Atoma] createCoreStore("${name}") 需要提供 adapter，或先调用 setDefaultAdapterFactory`)
    }

    const jotaiStore = config.store || globalStore
    const context = createStoreContext(config.queue, { debug: resolvedDebug, debugSink, storeName: name })
    const objectMapAtom = atom(new Map<StoreKey, T>())

    const runtime = createStoreRuntime<T>({
        atom: objectMapAtom,
        adapter: resolvedAdapter,
        config: {
            transformData: transformData ? (item: T) => transformData(item) ?? item : undefined,
            idGenerator: config.idGenerator,
            store: jotaiStore,
            schema: config.schema,
            hooks: config.hooks,
            indexes: config.indexes,
            context,
            devtools: config.devtools,
            storeName: name
        }
    })
    void runtime.stopIndexDevtools

    const { getOneById, fetchOneById } = createBatchGet(runtime)
    const findMany = createFindMany<T>(runtime)

    const store = {
        addOne: createAddOne<T>(runtime),
        updateOne: createUpdateOne<T>(runtime),
        deleteOneById: createDeleteOneById<T>(runtime),
        getAll: createGetAll<T>(runtime),
        getMultipleByIds: createGetMultipleByIds<T>(runtime),
        getOneById,
        fetchOneById,
        findMany
    } as IStore<T>

    const coreStore = store as unknown as CoreStore<T, Relations>
    coreStore.name = name

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

    config.devtools?.registerStore?.({ name, snapshot }) ?? registerGlobalStore({ name, snapshot })

    coreStore.getCachedOneById = (id: StoreKey) => {
        return jotaiStore.get(objectMapAtom).get(id)
    }

    coreStore.getCachedAll = () => {
        return Array.from(jotaiStore.get(objectMapAtom).values())
    }

    const applyRelations = (factory?: () => any) => {
        if (!factory) return
        let cache: RelationMap<T> | undefined
        const getter = () => {
            if (!cache) cache = factory()
            return cache
        }
        registerStoreAccess(coreStore as any, {
            atom: objectMapAtom as any,
            jotaiStore,
            context,
            adapter: resolvedAdapter as any,
            matcher: runtime.matcher,
            storeName: name,
            relations: getter as any,
            transform: runtime.transform as any,
            schema: runtime.schema as any,
            indexes: runtime.indexes as any
        })
    }

    coreStore.withRelations = <NewRelations extends Record<string, RelationConfig<any, any>>>(factory: () => NewRelations) => {
        applyRelations(factory)
        return coreStore as unknown as CoreStore<T, NewRelations>
    }

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

    applyRelations(getRelations)

    // 即使没有 relations，也要注册 atom/jotaiStore/matcher/storeName
    if (!resolveStoreAccess(coreStore)) {
        registerStoreAccess(coreStore, {
            atom: objectMapAtom,
            jotaiStore,
            context,
            adapter: resolvedAdapter as any,
            matcher: runtime.matcher,
            storeName: name,
            relations: undefined,
            transform: runtime.transform as any,
            schema: runtime.schema as any,
            indexes: runtime.indexes as any
        })
    }

    // 让 adapter（若支持）绑定 store access，用于 sync/pull/subscribe 写回
    const access = resolveStoreAccess(coreStore)
    if (access) {
        resolvedAdapter.attachStoreAccess?.(access as any)
    }

    return coreStore
}

export const createStore = createCoreStore
