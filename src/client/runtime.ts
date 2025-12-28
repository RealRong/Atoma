import type { CoreStore, IDataSource, IStore, JotaiStore, StoreHandle } from '#core'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { createStoreInstance } from './createAtomaStore'
import type { AtomaClientContext, StoresConstraint } from './types'

export type ClientRuntime = Readonly<{
    Store: (name: string) => CoreStore<any, any>
    resolveStore: (name: string) => IStore<any>
    listStores: () => Iterable<IStore<any>>
    onHandleCreated: (listener: (handle: StoreHandle<any>) => void, options?: { replay?: boolean }) => () => void
    jotaiStore: JotaiStore
}>

export function createClientRuntime(args: {
    stores: StoresConstraint<any>
    defaultDataSourceFactory: (name: string) => IDataSource<any>
}): ClientRuntime {
    const storeCache = new Map<string, CoreStore<any, any>>()
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
            defaultDataSourceFactory: args.defaultDataSourceFactory,
            Store: rawStore,
            resolveStore: rawStore
        }

        const { store: created, handle } = createStoreInstance({
            name,
            stores: args.stores,
            ctx
        })

        storeCache.set(key, created)

        if (handle) emitHandleCreated(handle)

        return created
    }

    return {
        Store: rawStore,
        resolveStore: rawStore,
        listStores: () => storeCache.values(),
        onHandleCreated,
        jotaiStore
    }
}
