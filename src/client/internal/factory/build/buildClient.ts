import type { CoreStore, Entity, StoreDataProcessor } from '#core'
import { HistoryController } from '#client/internal/controllers/HistoryController'
import { SyncController } from '#client/internal/controllers/SyncController'
import { ClientRuntime } from '#client/internal/factory/runtime/createClientRuntime'
import { resolveSyncWiring } from '#client/internal/factory/sync/resolveSyncWiring'
import { Shared } from '#shared'
import type {
    AtomaClient,
    AtomaSchema,
    BackendConfig,
    AtomaClientSyncConfig,
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
    sync?: AtomaClientSyncConfig
}): AtomaClient<Entities, Schema> {
    const storeBackendState = args.storeBackendState
    const syncConfig: AtomaClientSyncConfig | undefined = args.sync
    const wantsSync = Boolean(syncConfig)

    const syncEndpoint: BackendConfig | undefined = syncConfig
        ? {
            http: {
                baseURL: String(syncConfig.endpoint.url),
                ...(syncConfig.endpoint.http ?? {}),
                ...(syncConfig.endpoint.sse
                    ? {
                        subscribe: {
                            buildUrl: (args2?: { resources?: string[] }) => Shared.url.withResourcesParam(
                                Shared.url.resolveUrl(String(syncConfig.endpoint.url), String(syncConfig.endpoint.sse)),
                                args2?.resources
                            )
                        }
                    }
                    : {})
            } as any
        }
        : undefined

    const resolved = (() => {
        if (storeBackendState.role === 'local') {
            const remote = syncEndpoint
            const config: BackendConfig = remote
                ? { local: storeBackendState.backend, remote }
                : storeBackendState.backend
            const backends = resolveBackend(config)
            return {
                store: backends,
                sync: backends
            }
        }

        const store = resolveBackend(storeBackendState.backend)
        const sync = syncEndpoint ? resolveBackend(syncEndpoint) : undefined
        return { store, sync }
    })()

    const wiring = resolveSyncWiring({
        syncConfig
    })
    const outboxStore = wiring.outboxStore
    const cursorStore = wiring.cursorStore
    const lockKey = wiring.lockKey

    const storeBackend = resolved.store.store

    const clientRuntime = new ClientRuntime({
        schema: args.schema,
        dataProcessor: args.dataProcessor,
        opsClient: storeBackend.opsClient,
        syncStore: {
            queue: wiring.queue
        },
        outbox: outboxStore
    })

    const historyController = new HistoryController({ runtime: clientRuntime })

    const syncController = new SyncController({
        runtime: clientRuntime,
        backend: resolved.sync?.sync,
        localBackend: resolved.store.local,
        syncConfig,
        outboxStore,
        cursorStore,
        lockKey
    })

    const Store = (<Name extends keyof Entities & string>(name: Name) => {
        const store: any = clientRuntime.stores.Store(name) as any
        if (!('Outbox' in store)) {
            try {
                Object.defineProperty(store, 'Outbox', {
                    enumerable: false,
                    configurable: true,
                    get: () => clientRuntime.stores.SyncStore(name) as any
                })
            } catch {
                store.Outbox = clientRuntime.stores.SyncStore(name) as any
            }
        }
        return store as unknown as CoreStore<Entities[Name], any>
    }) as AtomaClient<Entities, Schema>['Store']

    const Sync = syncController.sync as AtomaClient<Entities, Schema>['Sync']

    const client: any = {
        Store,
        Sync,
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

    const clientDevtools = Devtools.createClientInspector({
        client,
        runtime: clientRuntime,
        syncDevtools: syncController.devtools,
        historyDevtools: historyController.devtools,
        meta: {
            storeBackend: {
                role: storeBackendState.role,
                kind
            },
            syncConfigured: wantsSync
        }
    })

    client.Devtools = clientDevtools

    return client as AtomaClient<Entities, Schema>
}
