import { atom } from 'jotai/vanilla'
import { storeHandleManager } from './store/internals/storeHandleManager'
import { createDirectStoreView } from './store/createDirectStoreView'
import { Shared } from '#shared'
import type {
    CoreRuntime,
    Entity,
    IStore,
    IndexDefinition,
    RelationConfig,
    StoreConfig,
} from './types'
import type { EntityId } from '#protocol'

const { parseOrThrow, z } = Shared.zod

export interface CoreStoreConfig<T extends Entity> extends StoreConfig<T> {
    name: string
    clientRuntime: CoreRuntime
    idGenerator?: () => EntityId
    indexes?: Array<IndexDefinition<T>>
}

export interface CoreStore<T extends Entity, Relations = {}> extends IStore<T, Relations> {
    name: string
    peek: (id: EntityId) => T | undefined
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
    config = parseOrThrow(
        z.object({
            relations: z.any().optional()
        })
            .loose()
            .superRefine((value: any, ctx) => {
                if (value.relations !== undefined && typeof value.relations !== 'function') {
                    ctx.addIssue({ code: 'custom', message: 'config.relations 必须是返回 RelationMap 的函数' })
                }
            }),
        config,
        { prefix: '[Atoma] createStore: ' }
    ) as any

    const { name } = config
    const clientRuntime = config.clientRuntime
    const jotaiStore = clientRuntime.jotaiStore
    const objectMapAtom = atom(new Map<EntityId, T>())

    clientRuntime.observability.registerStore?.({
        storeName: name,
        debug: config.debug,
        debugSink: config.debugSink
    })

    const handle = storeHandleManager.createStoreHandle<T>({
        atom: objectMapAtom,
        jotaiStore,
        config: {
            idGenerator: config.idGenerator,
            dataProcessor: config.dataProcessor,
            hooks: config.hooks,
            indexes: config.indexes,
            storeName: name
        }
    })
    const coreStore = createDirectStoreView<T, Relations>(clientRuntime, handle)

    const getRelations = (() => {
        const relationsFactory = config.relations
        if (!relationsFactory) return undefined
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
