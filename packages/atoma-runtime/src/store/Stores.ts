import type { Entity, Store, StoreDataProcessor, StoreToken } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, Schema, StoreHandle, StoreCatalog } from 'atoma-types/runtime'
import { StoreFactory, type StoreEngine, type StoreFacade } from './StoreFactory'

type StoreListener = (store: Store<Entity>) => void

const toStoreName = (name: unknown) => String(name)

export class Stores implements StoreCatalog {
    private readonly engineByName = new Map<string, StoreEngine>()
    private readonly facadeByName = new Map<string, StoreFacade>()
    private readonly created: Store<Entity>[] = []
    private readonly listeners = new Set<StoreListener>()
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

    private notifyCreated = (store: StoreFacade<Entity>) => {
        this.created.push(store)
        for (const listener of this.listeners) {
            try {
                listener(store)
            } catch {
                // ignore
            }
        }
    }

    private ensureEngine = (storeName: string): StoreEngine => {
        const name = toStoreName(storeName)
        const existing = this.engineByName.get(name)
        if (existing) return existing

        const built = this.storeFactory.build(name)
        const engine: StoreEngine = {
            handle: built.handle,
            api: built.api
        }

        this.runtime.events.emit.storeCreated({
            handle: built.handle,
            storeName: name
        })

        this.engineByName.set(name, engine)
        this.facadeByName.set(name, built.facade)
        this.notifyCreated(built.facade)

        return engine
    }

    resolve = (name: StoreToken): Store<Entity> | undefined => {
        const key = toStoreName(name)
        return this.facadeByName.get(key)
    }

    ensure = (name: StoreToken): Store<Entity> => {
        const key = toStoreName(name)
        this.ensureEngine(key)

        const facade = this.facadeByName.get(key)
        if (facade) return facade

        throw new Error(`[Atoma] ensure: 未找到 store facade（storeName=${key}）`)
    }

    list = () => this.facadeByName.values()

    onCreated = (listener: StoreListener, options?: { replay?: boolean }) => {
        if (options?.replay) {
            for (const store of this.created) {
                try {
                    listener(store)
                } catch {
                    // ignore
                }
            }
        }

        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    ensureHandle = (name: StoreToken, tag?: string): StoreHandle<Entity> => {
        const key = toStoreName(name)
        const existing = this.engineByName.get(key)
        if (existing) return existing.handle

        this.ensureEngine(key)
        const created = this.engineByName.get(key)
        if (created) return created.handle

        throw new Error(`[Atoma] ${tag || 'ensureHandle'}: 未找到 store handle（storeName=${key}）`)
    }
}
