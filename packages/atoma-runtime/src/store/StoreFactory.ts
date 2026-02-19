import { createId } from 'atoma-shared'
import type {
    Entity,
    Store,
    StoreDataProcessor,
    StoreToken
} from 'atoma-types/core'
import { compileRelationsMap } from 'atoma-core/relations'
import { STORE_BINDINGS, type StoreBindings } from 'atoma-types/internal'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime } from 'atoma-types/runtime'
import type { Schema, StoreSchema, StoreHandle } from 'atoma-types/runtime'
import { SimpleStoreState } from './StoreState'

export type StoreEngineApi<T extends Entity = Entity, Relations = {}> = Store<T, Relations>

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

        const create: StoreEngineApi<T>['create'] = (item, options) => this.runtime.write.create(handle, item, options)
        const createMany: StoreEngineApi<T>['createMany'] = (items, options) => this.runtime.write.createMany(handle, items, options)
        const update: StoreEngineApi<T>['update'] = (id, updater, options) => this.runtime.write.update(handle, id, updater, options)
        const updateMany: StoreEngineApi<T>['updateMany'] = (items, options) => this.runtime.write.updateMany(handle, items, options)
        const deleteOne: StoreEngineApi<T>['delete'] = (id, options) => this.runtime.write.delete(handle, id, options)
        const deleteMany: StoreEngineApi<T>['deleteMany'] = (ids, options) => this.runtime.write.deleteMany(handle, ids, options)
        const upsertOne: StoreEngineApi<T>['upsert'] = (item, options) => this.runtime.write.upsert(handle, item, options)
        const upsertMany: StoreEngineApi<T>['upsertMany'] = (items, options) => this.runtime.write.upsertMany(handle, items, options)

        const list: StoreEngineApi<T>['list'] = (options) => this.runtime.read.list(handle, options)
        const getMany: StoreEngineApi<T>['getMany'] = (ids, options) => this.runtime.read.getMany(handle, ids, options)
        const get: StoreEngineApi<T>['get'] = (id, options) => this.runtime.read.get(handle, id, options)
        const query: StoreEngineApi<T>['query'] = (input, options) => this.runtime.read.query(handle, input, options)
        const queryOne: StoreEngineApi<T>['queryOne'] = (input, options) => this.runtime.read.queryOne(handle, input, options)

        const api: StoreEngineApi<T> = {
            create,
            createMany,
            update,
            updateMany,
            delete: deleteOne,
            deleteMany,
            upsert: upsertOne,
            upsertMany,
            get,
            getMany,
            list,
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

            handle.state.applyWriteback({
                upserts: processed
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
