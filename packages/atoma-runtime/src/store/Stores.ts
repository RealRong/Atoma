import type {
    Entity,
    Query,
    QueryResult,
    Store,
    StoreChange,
    StoreDataProcessor,
    StoreDelta,
    StoreOperationOptions,
    StoreToken,
    StoreWritebackArgs,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Schema, StoreHandle, StoreCatalog, StoreSession } from 'atoma-types/runtime'
import { StoreFactory } from './StoreFactory'

type StoreEntry = Readonly<{
    handle: StoreHandle<Entity>
    api: Store<Entity>
    session: StoreSession<Entity>
}>

export class Stores implements StoreCatalog {
    private readonly stores = new Map<string, StoreEntry>()
    private readonly storeFactory: StoreFactory
    private readonly runtime: Runtime
    private readonly deps: {
        schema: Schema
        dataProcessor?: StoreDataProcessor<Entity>
        defaults?: {
            idGenerator?: () => EntityId
        }
    }

    constructor(
        runtime: Runtime,
        deps: {
            schema: Schema
            dataProcessor?: StoreDataProcessor<Entity>
            defaults?: {
                idGenerator?: () => EntityId
            }
        }
    ) {
        this.runtime = runtime
        this.deps = deps
        this.storeFactory = new StoreFactory({
            runtime: this.runtime,
            schema: this.deps.schema,
            defaults: this.deps.defaults,
            dataProcessor: this.deps.dataProcessor
        })
    }

    private ensureEntry = (name: StoreToken): StoreEntry => {
        const existing = this.stores.get(name)
        if (existing) return existing

        const built = this.storeFactory.build(name)
        const handle = built.handle as StoreHandle<Entity>
        const api = built.api as Store<Entity>
        const storeName = name as StoreToken
        const session: StoreSession<Entity> = {
            name: storeName,
            query: (query: Query<Entity>) => {
                return this.runtime.engine.query.evaluate({
                    state: handle.state,
                    query
                }) as QueryResult<Entity>
            },
            apply: async (
                changes: ReadonlyArray<StoreChange<Entity>>,
                options?: StoreOperationOptions
            ) => {
                await this.runtime.write.apply(handle, changes, options)
            },
            revert: async (
                changes: ReadonlyArray<StoreChange<Entity>>,
                options?: StoreOperationOptions
            ) => {
                await this.runtime.write.revert(handle, changes, options)
            },
            writeback: async (
                writeback: StoreWritebackArgs<Entity>,
                options?: StoreOperationOptions
            ) => {
                const context = options?.context
                    ? this.runtime.engine.action.createContext(options.context)
                    : undefined
                const upserts = Array.isArray(writeback.upserts) ? writeback.upserts : []
                const processed = upserts.length
                    ? await Promise.all(
                        upserts.map(item => this.runtime.transform.writeback(handle, item, context))
                    )
                    : []
                const deletes = Array.isArray(writeback.deletes) ? writeback.deletes : []
                const versionUpdates = Array.isArray(writeback.versionUpdates) ? writeback.versionUpdates : []

                return handle.state.writeback({
                    ...(processed.length ? { upserts: processed.filter((item): item is Entity => item !== undefined) } : {}),
                    ...(deletes.length ? { deletes } : {}),
                    ...(versionUpdates.length ? { versionUpdates } : {})
                }) as StoreDelta<Entity> | null
            }
        }

        const entry: StoreEntry = {
            handle,
            api,
            session
        }

        this.runtime.events.emit.storeCreated({
            storeName: name
        })

        this.stores.set(name, entry)

        return entry
    }

    ensure = <T extends Entity = Entity>(name: StoreToken): Store<T> => {
        return this.ensureEntry(name).api as unknown as Store<T>
    }

    use = <T extends Entity = Entity>(name: StoreToken): StoreSession<T> => {
        return this.ensureEntry(name).session as unknown as StoreSession<T>
    }

    inspect = <T extends Entity = Entity>(name: StoreToken): Readonly<{
        snapshot: ReadonlyMap<EntityId, T>
        indexes: StoreHandle<T>['state']['indexes']
    }> => {
        const entry = this.ensureEntry(name)
        const handle = entry.handle as unknown as StoreHandle<T>
        return {
            snapshot: handle.state.snapshot() as ReadonlyMap<EntityId, T>,
            indexes: handle.state.indexes
        }
    }

    list = (): StoreToken[] => {
        return Array.from(this.stores.keys()) as StoreToken[]
    }
}
