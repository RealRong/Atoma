import { createId } from 'atoma-shared'
import type {
    Entity,
    Query,
    QueryResult,
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

type BuildResult<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    api: Store<T>
}>

export class StoreFactory {
    private readonly runtime: Runtime
    private readonly schema: Schema
    private readonly defaults?: {
        idGenerator?: () => EntityId
    }
    private readonly dataProcessor?: StoreDataProcessor<Entity>

    constructor({
        runtime,
        schema,
        defaults,
        dataProcessor
    }: {
        runtime: Runtime
        schema: Schema
        defaults?: {
            idGenerator?: () => EntityId
        }
        dataProcessor?: StoreDataProcessor<Entity>
    }) {
        this.runtime = runtime
        this.schema = schema
        this.defaults = defaults
        this.dataProcessor = dataProcessor
    }

    build = <T extends Entity = Entity>(storeName: string): BuildResult<T> => {
        const runtime = this.runtime
        const name = String(storeName)
        const storeSchema = (this.schema?.[name] ?? {}) as StoreSchema<T>

        const idGenerator = storeSchema.idGenerator
            ?? this.defaults?.idGenerator
            ?? (() => createId({ kind: 'entity', sortable: true, now: runtime.now }))
        const dataProcessor = this.mergeDataProcessor(this.dataProcessor as StoreDataProcessor<T> | undefined, storeSchema.dataProcessor)

        const indexes = runtime.engine.index.create<T>(storeSchema.indexes ?? null)

        const state = new SimpleStoreState<T>({
            initial: new Map<EntityId, T>(),
            indexes,
            engine: runtime.engine
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

        if (storeSchema.relations) {
            let cachedRelations: unknown
            handle.relations = () => {
                if (cachedRelations === undefined) {
                    cachedRelations = compileRelationsMap(storeSchema.relations, name)
                }
                return cachedRelations
            }
        }

        const { read, write } = runtime

        const api: Store<T> = {
            create: (item, options) => write.create(handle, item, options),
            createMany: (items, options) => write.createMany(handle, items, options),
            update: (id, updater, options) => write.update(handle, id, updater, options),
            updateMany: (items, options) => write.updateMany(handle, items, options),
            delete: (id, options) => write.delete(handle, id, options),
            deleteMany: (ids, options) => write.deleteMany(handle, ids, options),
            upsert: (item, options) => write.upsert(handle, item, options),
            upsertMany: (items, options) => write.upsertMany(handle, items, options),
            get: (id, options) => read.get(handle, id, options),
            getMany: (ids, options) => read.getMany(handle, ids, options),
            list: (options) => read.list(handle, options),
            query: (input, options) => read.query(handle, input, options),
            queryOne: (input, options) => read.queryOne(handle, input, options)
        }

        const bindings = this.createBindings(name, handle)

        Object.defineProperty(api, STORE_BINDINGS, {
            value: bindings,
            enumerable: false,
            configurable: false
        })

        return { handle, api }
    }

    private createBindings = <T extends Entity>(storeName: string, handle: StoreHandle<T>): StoreBindings<T> => {
        const source = {
            getSnapshot: () => handle.state.snapshot() as ReadonlyMap<EntityId, T>,
            subscribe: (listener: () => void) => handle.state.subscribe(listener)
        }
        const state = () => {
            return {
                map: handle.state.snapshot() as ReadonlyMap<EntityId, T>,
                indexes: handle.state.indexes
            }
        }
        const query = (queryInput: Query<T>) => {
            return this.runtime.engine.query.evaluate({
                state: handle.state,
                query: queryInput
            }) as QueryResult<T>
        }

        return {
            name: storeName,
            scope: this.runtime as unknown as object,
            source,
            state,
            query,
            relation: this.runtime.engine.relation,
            relations: () => handle.relations?.(),
            useStore: (name: StoreToken) => this.runtime.stores.ensure(String(name)),
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
