import { atom } from 'jotai/vanilla'
import { createStoreHandle } from './store'
import type { JotaiStore } from './types'
import { createDirectStoreView } from './store/createDirectStoreView'
import type {
    Entity,
    IDataSource,
    IStore,
    IndexDefinition,
    LifecycleHooks,
    RelationConfig,
    SchemaValidator,
    StoreServices,
    StoreKey,
} from './types'

export interface CoreStoreConfig<T extends Entity> {
    name: string
    dataSource: IDataSource<T>
    transformData?: (data: T) => T | undefined
    idGenerator?: () => StoreKey
    store: JotaiStore
    schema?: SchemaValidator<T>
    hooks?: LifecycleHooks<T>
    indexes?: Array<IndexDefinition<T>>
    services: StoreServices
}

export interface CoreStore<T extends Entity, Relations = {}> extends IStore<T, Relations> {
    name: string
    peek: (id: StoreKey) => T | undefined
    peekAll: () => T[]
    /** Reset in-memory cache (atom + indexes). Does NOT touch remote/durable persistence. */
    reset: () => void
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

    const resolvedDataSource = config.dataSource

    const jotaiStore = config.store
    const services = config.services
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
            storeName: name
        }
    })
    const coreStore = createDirectStoreView<T, Relations>(handle)

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

    if (getRelations) {
        coreStore.withRelations(getRelations as any)
    }

    return coreStore as unknown as CoreStore<T, Relations>
}
