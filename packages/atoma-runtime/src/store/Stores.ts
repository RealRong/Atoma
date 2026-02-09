import type { Entity, IStore, StoreDataProcessor, StoreToken } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { CoreRuntime, RuntimeSchema, StoreHandle, StoreRegistry } from 'atoma-types/runtime'
import { StoreFactory, type StoreEngine, type StoreFacade } from './StoreFactory'

type StoreListener = (store: IStore<Entity>) => void

const toStoreName = (name: unknown) => String(name)

export class Stores implements StoreRegistry {
    private readonly engineByName = new Map<string, StoreEngine>()
    private readonly facadeByName = new Map<string, StoreFacade>()
    private readonly created: IStore<Entity>[] = []
    private readonly listeners = new Set<StoreListener>()
    private readonly storeFactory: StoreFactory

    constructor(
        private readonly runtime: CoreRuntime,
        private readonly args: {
            schema: RuntimeSchema
            dataProcessor?: StoreDataProcessor<Entity>
            defaults?: {
                idGenerator?: () => EntityId
            }
        }
    ) {
        this.storeFactory = new StoreFactory({
            runtime: this.runtime,
            schema: this.args.schema,
            defaults: this.args.defaults,
            dataProcessor: this.args.dataProcessor
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

        this.runtime.hooks.emit.storeCreated({
            handle: built.handle,
            storeName: name
        })

        this.engineByName.set(name, engine)
        this.facadeByName.set(name, built.facade)
        this.notifyCreated(built.facade)

        return engine
    }

    resolve = (name: StoreToken): IStore<Entity> | undefined => {
        const key = toStoreName(name)
        return this.facadeByName.get(key)
    }

    ensure = (name: StoreToken): IStore<Entity> => {
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

    resolveHandle = (name: StoreToken, tag?: string): StoreHandle<Entity> => {
        const key = toStoreName(name)
        const existing = this.engineByName.get(key)
        if (existing) return existing.handle

        this.ensureEngine(key)
        const created = this.engineByName.get(key)
        if (created) return created.handle

        throw new Error(`[Atoma] ${tag || 'resolveHandle'}: 未找到 store handle（storeName=${key}）`)
    }
}
