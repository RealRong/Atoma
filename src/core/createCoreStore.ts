import { atom } from 'jotai/vanilla'
import type { DevtoolsBridge, StoreSnapshot } from '../devtools/types'
import { getGlobalDevtools, registerGlobalStore } from '../devtools/global'
import { initializeLocalStore } from './initializeLocalStore'
import { registerStoreAccess } from './storeAccessRegistry'
import { globalStore } from './BaseStore'
import { createStoreContext } from './StoreContext'
import type { JotaiStore } from './types'
import { getDefaultAdapterFactory } from './defaultAdapterFactory'
import type { DebugOptions } from '../observability/types'
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
    debug?: DebugOptions
}

export interface CoreStore<T extends Entity, Relations extends RelationMap<T> = {}> extends IStore<T, Relations> {
    name: string
    getCachedOneById: (id: StoreKey) => T | undefined
    getCachedAll: () => T[]
    withRelations: <const NewRelations extends Record<string, RelationConfig<any, any>>>(factory: () => NewRelations) => CoreStore<T, NewRelations>
}

export function createCoreStore<T extends Entity, const Relations extends RelationMap<T>>(
    config: CoreStoreConfig<T> & { relations: () => Relations }
): CoreStore<T, Relations>

export function createCoreStore<T extends Entity, const Relations extends RelationMap<T> = {}>(
    config: CoreStoreConfig<T> & { relations?: () => Relations }
): CoreStore<T, Relations>

export function createCoreStore<T extends Entity, Relations extends RelationMap<T> = {}>(
    config: CoreStoreConfig<T> & { relations?: () => Relations }
): CoreStore<T, Relations> {
    const { name, transformData } = config
    const resolvedDebug: DebugOptions | undefined = config.debug
        ? {
            ...config.debug,
            sink: (e) => {
                // 先调用用户 sink（若有），再透传到 devtools
                if (config.debug?.sink) {
                    try {
                        config.debug.sink(e)
                    } catch {
                        // ignore
                    }
                }
                const bridge = config.devtools ?? getGlobalDevtools()
                try {
                    bridge?.emit({ type: 'debug-event', payload: e as any })
                } catch {
                    // ignore
                }
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
    const context = createStoreContext(config.queue, { debug: resolvedDebug, storeName: name })
    const objectMapAtom = atom(new Map<StoreKey, T>())

    const store = initializeLocalStore(objectMapAtom, resolvedAdapter, {
        transformData: transformData ? (item: T) => transformData(item) ?? item : undefined,
        idGenerator: config.idGenerator,
        store: jotaiStore,
        schema: config.schema,
        hooks: config.hooks,
        indexes: config.indexes,
        context,
        devtools: config.devtools,
        storeName: name
    }) as IStore<T>

    const coreStore = store as unknown as CoreStore<T, Relations>
    ;(coreStore as any).name = name

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

    const applyRelations = (factory?: () => RelationMap<T>) => {
        if (!factory) return
        let cache: RelationMap<T> | undefined
        const getter = () => {
            if (!cache) cache = factory()
            return cache
        }
        Object.defineProperty(coreStore as any, '_relations', {
            get: getter,
            configurable: true
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

    registerStoreAccess(coreStore as any, objectMapAtom as any, jotaiStore)

    return coreStore
}

export const createStore = createCoreStore
