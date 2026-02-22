import type {
    Entity,
    Query,
    QueryResult,
    Store,
    StoreChange,
    StoreProcessor,
    StoreDelta,
    StoreOperationOptions,
    StoreToken,
    StoreWritebackArgs,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Schema, StoreHandle, StoreCatalog, StoreSession } from 'atoma-types/runtime'
import { Factory } from './Factory'
import { ChangeFlow } from '../runtime/flows/ChangeFlow'

type CatalogEntry = Readonly<{
    handle: StoreHandle<Entity>
    api: Store<Entity>
    session: StoreSession<Entity>
}>

export class Catalog implements StoreCatalog {
    private readonly entries = new Map<string, CatalogEntry>()
    private readonly factory: Factory
    private readonly change: ChangeFlow
    private readonly runtime: Runtime
    private readonly deps: {
        schema: Schema
        createId?: () => EntityId
        processor?: StoreProcessor<Entity>
    }

    constructor(
        runtime: Runtime,
        deps: {
            schema: Schema
            createId?: () => EntityId
            processor?: StoreProcessor<Entity>
        }
    ) {
        this.runtime = runtime
        this.deps = deps
        this.change = new ChangeFlow(this.runtime)
        this.factory = new Factory({
            runtime: this.runtime,
            schema: this.deps.schema,
            createId: this.deps.createId,
            processor: this.deps.processor
        })
    }

    private ensureEntry = (name: StoreToken): CatalogEntry => {
        const existing = this.entries.get(name)
        if (existing) return existing

        const built = this.factory.build(name)
        const handle = built.handle as StoreHandle<Entity>
        const api = built.api as Store<Entity>
        const session: StoreSession<Entity> = {
            name,
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
                await this.change.apply(handle, changes, options)
            },
            revert: async (
                changes: ReadonlyArray<StoreChange<Entity>>,
                options?: StoreOperationOptions
            ) => {
                await this.change.revert(handle, changes, options)
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
                        upserts.map(item => this.runtime.processor.writeback(handle, item, context))
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

        const entry: CatalogEntry = {
            handle,
            api,
            session
        }

        this.runtime.events.emit('storeCreated', {
            storeName: name
        })

        this.entries.set(name, entry)

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
        const handle = entry.handle
        return {
            snapshot: handle.state.snapshot() as ReadonlyMap<EntityId, T>,
            indexes: handle.state.indexes
        }
    }

    list = (): StoreToken[] => {
        return Array.from(this.entries.keys()) as StoreToken[]
    }
}
