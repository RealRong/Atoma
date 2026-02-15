import { createId } from 'atoma-shared'
import type {
    Entity,
    Query,
    QueryOneResult,
    QueryResult,
    Store,
    StoreReadOptions,
    StoreDataProcessor,
    StoreToken
} from 'atoma-types/core'
import { compileRelationsMap } from 'atoma-core/relations'
import { STORE_BINDINGS, type StoreBindings } from 'atoma-types/internal'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime } from 'atoma-types/runtime'
import type { Schema, StoreSchema, StoreHandle } from 'atoma-types/runtime'
import { SimpleStoreState } from './StoreState'

export type StoreEngineApi<T extends Entity = Entity, Relations = {}> = Store<T, Relations> & Readonly<{
    fetchAll: (options?: StoreReadOptions) => Promise<T[]>
    query: (query: Query<T>, options?: StoreReadOptions) => Promise<QueryResult<T>>
    queryOne: (query: Query<T>, options?: StoreReadOptions) => Promise<QueryOneResult<T>>
}>

export type StoreEngine<T extends Entity = Entity, Relations = {}> = Readonly<{
    handle: StoreHandle<T>
    api: StoreEngineApi<T, Relations>
}>

export type StoreFacade<T extends Entity = Entity, Relations = {}> = Store<T, Relations> & { name: string }

export type StoreFactoryResult<T extends Entity = Entity, Relations = {}> = Readonly<{
    handle: StoreHandle<T>
    api: StoreEngineApi<T, Relations>
    facade: StoreFacade<T, Relations>
}>

export class StoreFactory {
    private readonly runtime: Runtime
    private readonly schema: Schema
    private readonly defaults?: {
        idGenerator?: () => EntityId
    }
    private readonly dataProcessor?: StoreDataProcessor<Entity>

    constructor(args: {
        runtime: Runtime
        schema: Schema
        defaults?: {
            idGenerator?: () => EntityId
        }
        dataProcessor?: StoreDataProcessor<Entity>
    }) {
        this.runtime = args.runtime
        this.schema = args.schema
        this.defaults = args.defaults
        this.dataProcessor = args.dataProcessor
    }

    build = <T extends Entity = Entity>(storeName: string): StoreFactoryResult<T> => {
        const name = String(storeName)
        const storeSchema = (this.schema?.[name] ?? {}) as StoreSchema<T>

        const idGenerator = storeSchema.idGenerator
            ?? this.defaults?.idGenerator
            ?? (() => createId({ kind: 'entity', sortable: true, now: this.runtime.now }))
        const dataProcessor = this.mergeDataProcessor(this.dataProcessor as StoreDataProcessor<T> | undefined, storeSchema.dataProcessor)

        const relationsFactory = storeSchema.relations
            ? () => compileRelationsMap(storeSchema.relations, name)
            : undefined

        const indexes = this.runtime.engine.index.create<T>(storeSchema.indexes ?? null)

        const state = new SimpleStoreState<T>({
            initial: new Map<EntityId, T>(),
            indexes,
            engine: this.runtime.engine
        })

        const handle: StoreHandle<T> = {
            state,
            storeName: name,
            config: {
                defaultRoute: storeSchema.write?.route,
                getAllMergePolicy: storeSchema.read?.getAllMergePolicy,
                hooks: storeSchema.hooks,
                idGenerator,
                dataProcessor
            }
        }

        if (typeof relationsFactory === 'function') {
            let cachedRelations: unknown
            handle.relations = () => {
                if (cachedRelations === undefined) {
                    cachedRelations = relationsFactory()
                }
                return cachedRelations
            }
        }

        const addOne: StoreEngineApi<T>['addOne'] = (item, options) => this.runtime.write.addOne(handle, item, options)
        const addMany: StoreEngineApi<T>['addMany'] = (items, options) => this.runtime.write.addMany(handle, items, options)
        const updateOne: StoreEngineApi<T>['updateOne'] = (id, recipe, options) => this.runtime.write.updateOne(handle, id, recipe, options)
        const updateMany: StoreEngineApi<T>['updateMany'] = (items, options) => this.runtime.write.updateMany(handle, items, options)
        const deleteOne: StoreEngineApi<T>['deleteOne'] = (id, options) => this.runtime.write.deleteOne(handle, id, options)
        const deleteMany: StoreEngineApi<T>['deleteMany'] = (ids, options) => this.runtime.write.deleteMany(handle, ids, options)
        const upsertOne: StoreEngineApi<T>['upsertOne'] = (item, options) => this.runtime.write.upsertOne(handle, item, options)
        const upsertMany: StoreEngineApi<T>['upsertMany'] = (items, options) => this.runtime.write.upsertMany(handle, items, options)

        const getAll: StoreEngineApi<T>['getAll'] = (filter, cacheFilter) => this.runtime.read.getAll(handle, filter, cacheFilter)
        const getMany: StoreEngineApi<T>['getMany'] = (ids, cache) => this.runtime.read.getMany(handle, ids, cache)
        const getOne: StoreEngineApi<T>['getOne'] = (id) => this.runtime.read.getOne(handle, id)
        const fetchOne: StoreEngineApi<T>['fetchOne'] = (id, options) => this.runtime.read.fetchOne(handle, id, options)
        const fetchAll: StoreEngineApi<T>['fetchAll'] = (options) => this.runtime.read.fetchAll(handle, options)
        const query: StoreEngineApi<T>['query'] = (input, options) => this.runtime.read.query(handle, input, options)
        const queryOne: StoreEngineApi<T>['queryOne'] = (input, options) => this.runtime.read.queryOne(handle, input, options)

        const api: StoreEngineApi<T> = {
            addOne,
            addMany,
            updateOne,
            updateMany,
            deleteOne,
            deleteMany,
            upsertOne,
            upsertMany,
            getOne,
            fetchOne,
            getAll,
            fetchAll,
            getMany,
            query,
            queryOne
        }

        const facade = this.createFacade(name, api)
        const bindings = this.createBindings(name, handle)

        Object.defineProperty(facade, STORE_BINDINGS, {
            value: bindings,
            enumerable: false,
            configurable: false
        })

        return { handle, api, facade }
    }

    private createFacade = <T extends Entity, Relations = {}>(storeName: string, api: StoreEngineApi<T, Relations>): StoreFacade<T, Relations> => {
        return {
            name: storeName,
            ...api
        }
    }

    private createBindings = <T extends Entity>(storeName: string, handle: StoreHandle<T>): StoreBindings<T> => {
        const source = {
            getSnapshot: () => handle.state.getSnapshot() as ReadonlyMap<EntityId, T>,
            subscribe: (listener: () => void) => handle.state.subscribe(listener)
        }

        const hydrate = async (items: T[]) => {
            if (!items.length) return

            const processed: T[] = []
            for (const item of items) {
                const normalized = await this.runtime.transform.writeback(handle, item)
                if (normalized !== undefined) {
                    processed.push(normalized)
                }
            }
            if (!processed.length) return

            const before = handle.state.getSnapshot() as Map<EntityId, T>
            const result = this.runtime.engine.mutation.upsertItems(before, processed)

            if (result.after === before) return
            handle.state.commit({
                before,
                after: result.after,
                changedIds: new Set(processed.map(item => item.id))
            })
        }

        return {
            name: storeName,
            cacheKey: this.runtime as unknown as object,
            source,
            engine: this.runtime.engine,
            indexes: handle.state.indexes,
            relations: () => handle.relations?.(),
            ensureStore: (name: StoreToken) => this.runtime.stores.ensure(String(name)),
            hydrate
        }
    }

    private mergeDataProcessor = <T extends Entity>(
        base?: StoreDataProcessor<T>,
        override?: StoreDataProcessor<T>
    ): StoreDataProcessor<T> | undefined => {
        if (!base && !override) return undefined
        return {
            ...(base ?? {}),
            ...(override ?? {})
        }
    }
}
