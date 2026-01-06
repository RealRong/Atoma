import type { CoreStore, IDataSource, IStore, JotaiStore, StoreHandle, StoreKey } from '#core'
import { Core } from '#core'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { createStoreInstance } from './createAtomaStore'
import type { AtomaClientContext, AtomaSchema, ClientRuntime } from './types'
import type { SyncStore } from '#core'

export function createClientRuntime(args: {
    schema: AtomaSchema<any>
    defaults: {
        dataSourceFactory: (name: string) => IDataSource<any>
        idGenerator?: () => StoreKey
    }
    syncStore?: {
        mode?: 'intent-only' | 'local-first'
    }
}): ClientRuntime {
    const storeCache = new Map<string, CoreStore<any, any>>()
    const handleCache = new Map<string, StoreHandle<any>>()
    const syncStoreCache = new Map<string, SyncStore<any, any>>()
    const jotaiStore: JotaiStore = createJotaiStore()

    const handles: StoreHandle<any>[] = []
    const handleListeners = new Set<(handle: StoreHandle<any>) => void>()

    const emitHandleCreated = (handle: StoreHandle<any>) => {
        handles.push(handle)

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
            for (const handle of handles) {
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

    const rawStore = (name: string) => {
        const key = String(name)
        const existing = storeCache.get(key)
        if (existing) return existing

        const ctx: AtomaClientContext<any, any> = {
            jotaiStore,
            defaults: args.defaults,
            Store: rawStore,
            resolveStore: rawStore
        }

        const { store: created, handle } = createStoreInstance({
            name,
            schema: args.schema,
            ctx
        })

        if (handle) {
            handleCache.set(key, handle)
            emitHandleCreated(handle)

            const view = Core.store.createDirectStoreView(handle)
            storeCache.set(key, view as any)
            return view as any
        }

        storeCache.set(key, created)
        return created
    }

    return {
        Store: rawStore,
        SyncStore: (name: string) => {
            const key = String(name)
            const existing = syncStoreCache.get(key)
            if (existing) return existing

            const base = rawStore(key)
            const handle = handleCache.get(key) ?? Core.store.getHandle(base)
            if (!handle) {
                throw new Error(`[Atoma] Sync.Store: 未找到 storeHandle（store="${key}"）`)
            }

            const view = Core.store.createSyncStoreView(handle, args.syncStore)
            syncStoreCache.set(key, view as any)
            return view as any
        },
        resolveStore: rawStore,
        listStores: () => storeCache.values(),
        onHandleCreated,
        jotaiStore
    }
}
