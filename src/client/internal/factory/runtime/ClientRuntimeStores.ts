import type { CoreStore, IStore, StoreDataProcessor, StoreToken } from '#core'
import { Core } from '#core'
import type { EntityId } from '#protocol'
import type { AtomaSchema } from '#client/types'
import type { SyncStore } from '#core'
import { storeHandleManager } from '#core/store/internals/storeHandleManager'
import type { ClientRuntimeInternal } from '#client/internal/types'
import type { ClientRuntimeStoresApi } from '#client/types/runtime'
import { resolveStoreCreateOptions } from '#client/internal/factory/runtime/storeConfig'

type StoreListener = (store: CoreStore<any, any>) => void
const toStoreKey = (name: unknown) => String(name)

export class ClientRuntimeStores implements ClientRuntimeStoresApi {
    private storeCache = new Map<string, CoreStore<any, any>>()
    private syncStoreCache = new Map<string, SyncStore<any, any>>()
    private createdStores: CoreStore<any, any>[] = []
    private storeListeners = new Set<StoreListener>()

    constructor(
        private readonly runtime: ClientRuntimeInternal,
        private readonly args: {
            schema: AtomaSchema<any>
            dataProcessor?: StoreDataProcessor<any>
            defaults?: {
                idGenerator?: () => EntityId
            }
            syncStore?: {
                queue?: 'queue' | 'local-first'
            }
        }
    ) {}

    private notifyStoreCreated = (store: CoreStore<any, any>) => {
        this.createdStores.push(store)
        for (const listener of this.storeListeners) {
            try {
                listener(store)
            } catch {
                // ignore
            }
        }
    }

    Store = (name: string) => {
        const key = toStoreKey(name)
        const existing = this.storeCache.get(key)
        if (existing) return existing

        const created = Core.store.createStore<any, any>(resolveStoreCreateOptions({
            storeName: key,
            schema: this.args.schema,
            clientRuntime: this.runtime,
            defaults: this.args.defaults,
            dataProcessor: this.args.dataProcessor
        }))

        this.storeCache.set(key, created)
        this.notifyStoreCreated(created)
        return created
    }

    resolveStore = (name: StoreToken): IStore<any> | undefined => this.Store(toStoreKey(name))

    SyncStore = (name: string) => {
        const key = toStoreKey(name)
        const existing = this.syncStoreCache.get(key)
        if (existing) return existing as any

        const base = this.Store(key)
        const handle = storeHandleManager.requireStoreHandle(base, `Store.SyncStore:${key}`)
        const view = Core.store.createSyncStoreView(this.runtime, handle, this.args.syncStore)

        this.syncStoreCache.set(key, view as any)
        return view as any
    }

    listStores = () => this.storeCache.values()

    onStoreCreated = (listener: StoreListener, options?: { replay?: boolean }) => {
        if (options?.replay) {
            for (const store of this.createdStores) {
                try {
                    listener(store)
                } catch {
                    // ignore
                }
            }
        }
        this.storeListeners.add(listener)
        return () => {
            this.storeListeners.delete(listener)
        }
    }
}
