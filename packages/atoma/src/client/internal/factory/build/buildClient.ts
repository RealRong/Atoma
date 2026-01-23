import type { CoreStore, Entity, StoreDataProcessor } from '#core'
import { createStoreView } from '#core/store/createStoreView'
import { storeHandleManager } from '#core/store/internals/storeHandleManager'
import { HistoryController } from '#client/internal/controllers/HistoryController'
import { ClientRuntime } from '#client/internal/factory/runtime/createClientRuntime'
import type {
    AtomaClient,
    AtomaSchema,
    StoreBackendState,
    StoreBatchArgs,
} from '#client/types'
import { resolveBackend } from '#client/internal/factory/backend/resolveBackend'
import { Devtools } from '#devtools'

export function buildAtomaClient<
    const Entities extends Record<string, Entity>,
    const Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
>(args: {
    schema: Schema
    dataProcessor?: StoreDataProcessor<any>
    storeBackendState: StoreBackendState
    storeBatch?: StoreBatchArgs
}): AtomaClient<Entities, Schema> {
    const storeBackendState = args.storeBackendState
    const resolved = resolveBackend(storeBackendState.backend)
    const storeBackend = resolved.store

    const clientRuntime = new ClientRuntime({
        schema: args.schema,
        dataProcessor: args.dataProcessor,
        opsClient: storeBackend.opsClient
    })

    const historyController = new HistoryController({ runtime: clientRuntime })

    const Store = (<Name extends keyof Entities & string>(name: Name) => {
        const store: any = clientRuntime.stores.Store(name) as any
        return store as unknown as CoreStore<Entities[Name], any>
    }) as AtomaClient<Entities, Schema>['Store']

    const client: any = {
        Store,
        History: historyController.history
    }

    const kind = (() => {
        const b: any = storeBackendState.backend
        if (typeof b === 'string') return 'http' as const
        if (b && typeof b === 'object' && !Array.isArray(b)) {
            if ('indexeddb' in b) return 'indexeddb' as const
            if ('memory' in b) return 'memory' as const
            if ('opsClient' in b) return 'custom' as const
            if ('http' in b) return (storeBackendState.role === 'local' ? 'localServer' : 'http') as 'localServer' | 'http'
        }
        return 'custom' as const
    })()

    // Plugin system (core is intentionally sync-agnostic).
    const installed = new Set<string>()
    const pluginDisposers: Array<() => void> = []
    const disposeListeners = new Set<() => void>()

    const onDispose = (fn: () => void) => {
        disposeListeners.add(fn)
        return () => {
            disposeListeners.delete(fn)
        }
    }

    const ctx: import('#client/types').ClientPluginContext = {
        client,
        meta: {
            storeBackend: {
                role: storeBackendState.role,
                kind
            }
        },
        onDispose,
        persistence: {
            register: clientRuntime.persistenceRouter.register
        },
        acks: clientRuntime.mutation.acks,
        writeback: {
            apply: (storeName, writeback) => clientRuntime.internal.applyWriteback(String(storeName), writeback as any)
        },
        stores: {
            view: (store, args2) => {
                const name = storeHandleManager.getStoreName(store as any, 'plugin.view')
                const handle = storeHandleManager.requireStoreHandle(store as any, `plugin.view:${name}`)
                const allowImplicitFetchForWrite = (typeof args2.allowImplicitFetchForWrite === 'boolean')
                    ? args2.allowImplicitFetchForWrite
                    : handle.writePolicies?.allowImplicitFetchForWrite !== false

                return createStoreView(clientRuntime as any, handle as any, {
                    writeConfig: {
                        persistKey: args2.persistKey,
                        allowImplicitFetchForWrite
                    },
                    includeServerAssignedCreate: args2.includeServerAssignedCreate !== false
                }) as any
            }
        },
        runtime: {
            opsClient: clientRuntime.opsClient,
            observability: clientRuntime.observability
        }
    }

    client.use = (plugin: any) => {
        const name = String(plugin?.name ?? '')
        if (!name) throw new Error('[Atoma] client.use(plugin): plugin.name 必填')
        if (installed.has(name)) return client
        installed.add(name)

        const res = plugin.setup(ctx) ?? {}
        const extension = res.extension
        if (extension && typeof extension === 'object') {
            for (const [k, v] of Object.entries(extension)) {
                if (k in client) throw new Error(`[Atoma] client.use(${name}): extension 冲突字段 "${k}"`)
                ;(client as any)[k] = v
            }
        }

        if (typeof res.dispose === 'function') {
            pluginDisposers.push(res.dispose)
        }

        return client
    }

    let disposed = false
    client.dispose = () => {
        if (disposed) return
        disposed = true

        for (let i = pluginDisposers.length - 1; i >= 0; i--) {
            try {
                pluginDisposers[i]!()
            } catch {
                // ignore
            }
        }

        for (const fn of Array.from(disposeListeners)) {
            try {
                fn()
            } catch {
                // ignore
            }
        }

        try {
            client.Devtools?.dispose?.()
        } catch {
            // ignore
        }
    }

    const clientDevtools = Devtools.createClientInspector({
        client,
        runtime: clientRuntime,
        historyDevtools: historyController.devtools,
        meta: {
            storeBackend: {
                role: storeBackendState.role,
                kind
            },
        }
    })

    client.Devtools = clientDevtools

    return client as AtomaClient<Entities, Schema>
}
