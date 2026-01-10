import type { CoreStore, IDataSource, JotaiStore, StoreHandle, StoreKey } from '#core'
import { Core } from '#core'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { createStoreInstance } from './createStore'
import type { AtomaClientContext, AtomaSchema, ClientRuntime } from '../types'
import type { SyncStore } from '#core'

export function createRuntime(args: {
    schema: AtomaSchema<any>
    defaults: {
        dataSourceFactory: (name: string) => IDataSource<any>
        idGenerator?: () => StoreKey
    }
    syncStore?: {
        queue?: 'queue' | 'local-first'
    }
}): ClientRuntime {
    const storeCache = new Map<string, CoreStore<any, any>>()
    const handleCache = new Map<string, StoreHandle<any>>()
    const syncStoreCache = new Map<string, SyncStore<any, any>>()
    const jotaiStore: JotaiStore = createJotaiStore()

    const createdHandles: StoreHandle<any>[] = []
    const handleListeners = new Set<(handle: StoreHandle<any>) => void>()

    const notifyHandleCreated = (handle: StoreHandle<any>) => {
        createdHandles.push(handle)

        for (const listener of handleListeners) {
            try {
                listener(handle)
            } catch {
                // ignore
            }
        }
    }

    const onHandleCreated = (listener: (handle: StoreHandle<any>) => void, options?: { replay?: boolean }) => {
        if (options?.replay) {
            for (const handle of createdHandles) {
                try {
                    listener(handle)
                } catch {
                    // ignore
                }
            }
        }
        handleListeners.add(listener)
        return () => {
            handleListeners.delete(listener)
        }
    }

    const getOrCreateStore = (name: string) => {
        const key = String(name)
        const existing = storeCache.get(key)
        if (existing) return existing

        const context: AtomaClientContext<any, any> = {
            jotaiStore,
            defaults: args.defaults,
            Store: getOrCreateStore,
            resolveStore: getOrCreateStore
        }

        const { store: created, handle } = createStoreInstance({
            name,
            schema: args.schema,
            ctx: context
        })

        if (handle) {
            handleCache.set(key, handle)
            notifyHandleCreated(handle)
        }

        storeCache.set(key, created)
        return created
    }

    return {
        Store: getOrCreateStore,
        SyncStore: (name: string) => {
            const key = String(name)
            const existing = syncStoreCache.get(key)
            if (existing) return existing

            const base = getOrCreateStore(key)
            const handle = handleCache.get(key) ?? Core.store.getHandle(base)
            if (!handle) {
                throw new Error(`[Atoma] Store.Outbox: 未找到 storeHandle（store="${key}"）`)
            }

            const view = Core.store.createSyncStoreView(handle, args.syncStore)
            syncStoreCache.set(key, view as any)
            return view as any
        },
        resolveStore: getOrCreateStore,
        listStores: () => storeCache.values(),
        onHandleCreated,
        jotaiStore
    }
}
