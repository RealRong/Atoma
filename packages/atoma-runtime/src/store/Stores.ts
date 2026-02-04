import type * as Types from 'atoma-types/core'
import type { RuntimeSchema, StoreHandle, StoreRegistry } from 'atoma-types/runtime'
import type { EntityId } from 'atoma-types/protocol'
import type { CoreRuntime } from 'atoma-types/runtime'
import { StoreFactory, type StoreEngine } from './StoreFactory'

type StoreListener = (store: Types.StoreApi<any, any> & { name: string }) => void

const toStoreName = (name: unknown) => String(name)

export class Stores implements StoreRegistry {
    private readonly engineByName = new Map<string, StoreEngine<any>>()
    private readonly facadeByName = new Map<string, Types.StoreApi<any, any> & { name: string }>()
    private readonly created: Array<Types.StoreApi<any, any> & { name: string }> = []
    private readonly listeners = new Set<StoreListener>()
    private readonly storeFactory: StoreFactory

    constructor(
        private readonly runtime: CoreRuntime,
        private readonly args: {
            schema: RuntimeSchema
            dataProcessor?: Types.StoreDataProcessor<any>
            defaults?: {
                idGenerator?: () => EntityId
            }
            ownerClient?: () => unknown
        }
    ) {
        this.storeFactory = new StoreFactory({
            runtime: this.runtime,
            schema: this.args.schema,
            defaults: this.args.defaults,
            dataProcessor: this.args.dataProcessor,
            ownerClient: this.args.ownerClient
        })
    }

    private notifyCreated = (store: Types.StoreApi<any, any> & { name: string }) => {
        this.created.push(store)
        for (const listener of this.listeners) {
            try {
                listener(store)
            } catch {
                // ignore
            }
        }
    }

    private ensureEngine = (storeName: string): StoreEngine<any> => {
        const name = toStoreName(storeName)
        const existing = this.engineByName.get(name)
        if (existing) return existing

        const built = this.storeFactory.build(name)
        const handle = built.handle
        const api = built.api
        const facade = built.facade

        this.runtime.hooks.emit.storeCreated({
            handle,
            storeName: name
        })

        const engine: StoreEngine<any> = { handle, api }
        this.engineByName.set(name, engine)
        this.facadeByName.set(name, facade)

        // Notify only when the handle exists (so devtools/inspect can immediately read).
        this.notifyCreated(facade)

        return engine
    }

    resolve = (name: Types.StoreToken): Types.IStore<any> | undefined => {
        const key = toStoreName(name)
        return this.facadeByName.get(key)
    }

    ensure = (name: Types.StoreToken): Types.IStore<any> => {
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

    resolveHandle = (name: Types.StoreToken, tag?: string): StoreHandle<any> => {
        const key = toStoreName(name)
        const existing = this.engineByName.get(key)
        if (existing) return existing.handle

        // Lazy creation for internal access.
        this.ensureEngine(key)
        const created = this.engineByName.get(key)
        if (created) return created.handle

        throw new Error(`[Atoma] ${tag || 'resolveHandle'}: 未找到 store handle（storeName=${key}）`)
    }
}
