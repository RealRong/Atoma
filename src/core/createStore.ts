import { atom } from 'jotai/vanilla'
import type { DevtoolsBridge, StoreSnapshot } from '../devtools/types'
import { getGlobalDevtools, registerGlobalStore } from '../devtools/global'
import {
    createAddMany,
    createAddOne,
    createBatchGet,
    createDeleteMany,
    createDeleteOne,
    createFindMany,
    createGetAll,
    createGetMany,
    createStoreHandle,
    createUpdateMany,
    createUpdateOne,
    createUpsertMany,
    createUpsertOne
} from './store'
import { registerStoreHandle } from './storeHandleRegistry'
import { MutationPipeline } from './mutation'
import type { JotaiStore } from './types'
import type { DebugConfig, DebugEvent } from '#observability'
import type {
    Entity,
    IDataSource,
    IStore,
    IndexDefinition,
    LifecycleHooks,
    RelationConfig,
    RelationMap,
    SchemaValidator,
    StoreKey,
    StoreToken
} from './types'

export interface StoreServices {
    mutation: MutationPipeline
    resolveStore?: (name: StoreToken) => IStore<any> | undefined
    debug?: DebugConfig
    debugSink?: (e: DebugEvent) => void
}

export interface CoreStoreConfig<T extends Entity> {
    name: string
    dataSource: IDataSource<T>
    transformData?: (data: T) => T | undefined
    idGenerator?: () => StoreKey
    store: JotaiStore
    schema?: SchemaValidator<T>
    hooks?: LifecycleHooks<T>
    indexes?: Array<IndexDefinition<T>>
    devtools?: DevtoolsBridge
    debug?: DebugConfig
    resolveStore?: (name: StoreToken) => IStore<any> | undefined
}

export interface CoreStore<T extends Entity, Relations = {}> extends IStore<T, Relations> {
    name: string
    getCachedOneById: (id: StoreKey) => T | undefined
    getCachedAll: () => T[]
    withRelations: <const NewRelations extends Record<string, RelationConfig<any, any>>>(factory: () => NewRelations) => CoreStore<T, NewRelations>
}

export function createStore<T extends Entity, const Relations>(
    config: CoreStoreConfig<T> & { relations: () => Relations }
): CoreStore<T, Relations>

export function createStore<T extends Entity, const Relations = {}>(
    config: CoreStoreConfig<T> & { relations?: () => Relations }
): CoreStore<T, Relations>

export function createStore<T extends Entity, Relations = {}>(
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

    const resolvedDataSource = config.dataSource

    const jotaiStore = config.store
    const services: StoreServices = {
        mutation: new MutationPipeline(),
        resolveStore: config.resolveStore,
        debug: resolvedDebug,
        debugSink
    }
    const objectMapAtom = atom(new Map<StoreKey, T>())

    const handle = createStoreHandle<T>({
        atom: objectMapAtom,
        dataSource: resolvedDataSource,
        config: {
            transformData: transformData ? (item: T) => transformData(item) ?? item : undefined,
            idGenerator: config.idGenerator,
            store: jotaiStore,
            schema: config.schema,
            hooks: config.hooks,
            indexes: config.indexes,
            services,
            devtools: config.devtools,
            storeName: name
        }
    })
    void handle.stopIndexDevtools

    const { getOne, fetchOne } = createBatchGet(handle)
    const findMany = createFindMany<T>(handle)

    const store = {
        addOne: createAddOne<T>(handle),
        addMany: createAddMany<T>(handle),
        updateOne: createUpdateOne<T>(handle),
        updateMany: createUpdateMany<T>(handle),
        deleteOne: createDeleteOne<T>(handle),
        deleteMany: createDeleteMany<T>(handle),
        upsertOne: createUpsertOne<T>(handle),
        upsertMany: createUpsertMany<T>(handle),
        getAll: createGetAll<T>(handle),
        getMany: createGetMany<T>(handle),
        getOne,
        fetchOne,
        findMany
    } as IStore<T>

    const coreStore = store as unknown as CoreStore<T, Relations>
    coreStore.name = name
    registerStoreHandle(coreStore, handle)

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
        handle.relations = getter as any
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

    return coreStore
}
