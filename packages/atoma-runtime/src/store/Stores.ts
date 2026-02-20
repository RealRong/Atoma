import type { Entity, Store, StoreDataProcessor, StoreToken } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Schema, StoreHandle, StoreCatalog } from 'atoma-types/runtime'
import { StoreFactory, type StoreFacade } from './StoreFactory'

type StoreEntry = Readonly<{
    handle: StoreHandle<Entity>
    facade: StoreFacade<Entity>
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
        const entry: StoreEntry = {
            handle: built.handle,
            facade: built.facade
        }

        this.runtime.events.emit.storeCreated({
            handle: built.handle,
            storeName: name
        })

        this.stores.set(name, entry)

        return entry
    }

    ensure = (name: StoreToken): Store<Entity> => {
        return this.ensureEntry(name).facade
    }

    private *iterateFacades(): Iterable<Store<Entity>> {
        for (const { facade } of this.stores.values()) {
            yield facade
        }
    }

    list = () => this.iterateFacades()

    ensureHandle = (name: StoreToken, tag?: string): StoreHandle<Entity> => {
        const existing = this.stores.get(name)
        if (existing) return existing.handle

        this.ensureEntry(name)
        const created = this.stores.get(name)
        if (created) return created.handle

        throw new Error(`[Atoma] ${tag || 'ensureHandle'}: 未找到 store handle（storeName=${String(name)}）`)
    }
}
