import type { CoreStore, IStore, JotaiStore, StoreHandle } from '#core'
import { Core } from '#core'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { createAtomaStore } from './createAtomaStore'
import type { AtomaClientContext, DefineClientConfig, StoresConstraint } from './types'

export type ClientRuntime = Readonly<{
    Store: (name: string) => CoreStore<any, any>
    resolveStore: (name: string) => IStore<any>
    listStores: () => Iterable<IStore<any>>
    onHandleCreated: (listener: (handle: StoreHandle<any>) => void, options?: { replay?: boolean }) => () => void
    jotaiStore: JotaiStore
}>

export function createClientRuntime(args: {
    stores: StoresConstraint<any>
    config: DefineClientConfig<any>
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

    const rawStore = (name: string): any => {
        const key = String(name)
        const existing = storeCache.get(key)
        if (existing) return existing as any

        const ctx: AtomaClientContext<any, any> = {
            jotaiStore,
            defaultAdapterFactory: args.config.defaultAdapterFactory as any,
            Store: rawStore as any,
            resolveStore: rawStore as any
        }

        const override = (args.stores as any)?.[name]
        const created = (() => {
            if (!override) return createAtomaStore(ctx, { name } as any)
            if (typeof override === 'function') return override(ctx)
            if (typeof (override as any)?.name === 'string' && (override as any).name !== name) {
                throw new Error(`[Atoma] defineStores(...).defineClient: stores["${String(name)}"].name 不一致（收到 "${String((override as any).name)}"）`)
            }
            return createAtomaStore(ctx, { ...(override as any), name } as any)
        })()

        storeCache.set(key, created)

        const handle = Core.store.getHandle(created)
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
