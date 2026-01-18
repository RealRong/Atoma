import type { CoreStore, Entity } from '#core'
import { createHistoryController } from '../controllers/HistoryController'
import { createSyncController } from '../controllers/SyncController'
import { createClientRuntime } from './createClientRuntime'
import type {
    AtomaClient,
    AtomaSchema,
    BackendConfig,
    BackendEndpointConfig,
    StoreBackendState,
    StoreBackendEndpointConfig,
    StoreBatchArgs,
    SyncDefaultsArgs,
    SyncQueueMode,
    SyncQueueWritesArgs
} from '../../types'
import { resolveBackend } from '../resolveBackend'
import { Devtools } from '#devtools'

export function buildAtomaClient<
    const Entities extends Record<string, Entity>,
    const Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
>(args: {
    schema: Schema
    storeBackendState: StoreBackendState
    storeBatch?: StoreBatchArgs
    syncEndpoint?: BackendEndpointConfig
    syncDefaults?: SyncDefaultsArgs
    syncQueueWrites?: SyncQueueWritesArgs
    syncQueueMode?: SyncQueueMode
}): AtomaClient<Entities, Schema> {
    const storeBackendState = args.storeBackendState
    const syncQueue = args.syncQueueWrites
    const defaults = args.syncDefaults

    const wantsSync = Boolean(args.syncEndpoint || syncQueue || defaults)

    const derivedSyncEndpoint = (!args.syncEndpoint && storeBackendState.role === 'remote')
        ? storeBackendState.backend
        : undefined

    const syncEndpoint: BackendConfig | undefined = args.syncEndpoint ?? derivedSyncEndpoint

    if (wantsSync && !syncEndpoint) {
        throw new Error('[Atoma] createClient: 使用 sync 相关配置前必须先配置 sync 对端（sync.url/sync.backend），或将 store.type 设为 http/custom(remote) 以复用 store 对端')
    }

    const queue: SyncQueueMode | undefined = syncQueue
        ? (args.syncQueueMode ?? (storeBackendState.role === 'local' ? 'local-first' : 'queue'))
        : undefined

    if (queue === 'local-first' && storeBackendState.role !== 'local') {
        throw new Error('[Atoma] createClient: sync.queue=\"local-first\" 需要 store 为本地 durable（indexeddb/localServer/custom local）')
    }

    const resolved = (() => {
        if (storeBackendState.role === 'local') {
            const remote = args.syncEndpoint
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
        const sync = syncEndpoint ? resolveBackend(syncEndpoint) : store
        return { store, sync }
    })()

    if (wantsSync && !resolved.sync?.sync) {
        throw new Error('[Atoma] createClient: sync 对端必须支持同步（需要 remote opsClient 能力）')
    }

    const storeBackend = resolved.store.store

    const clientRuntime = createClientRuntime({
        schema: args.schema,
        opsClient: storeBackend.opsClient,
        syncStore: {
            queue
        }
    })

    const historyController = createHistoryController({ runtime: clientRuntime })

    const syncConfig = wantsSync
        ? ({
            mode: defaults?.mode,
            deviceId: defaults?.deviceId,
            advanced: defaults?.advanced,
            resources: defaults?.resources,
            subscribe: defaults?.subscribe,
            subscribeEventName: defaults?.subscribeEventName,
            pullLimit: defaults?.pullLimit,
            pullDebounceMs: defaults?.pullDebounceMs,
            pullIntervalMs: defaults?.pullIntervalMs,
            reconnectDelayMs: defaults?.reconnectDelayMs,
            inFlightTimeoutMs: defaults?.inFlightTimeoutMs,
            retry: defaults?.retry,
            backoff: defaults?.backoff,
            now: defaults?.now,
            conflictStrategy: defaults?.conflictStrategy,
            returning: defaults?.returning,
            onEvent: defaults?.onEvent,
            onError: defaults?.onError,
            ...(syncQueue ? {
                maxQueueSize: syncQueue.maxQueueSize,
                outboxEvents: (syncQueue.onQueueChange || syncQueue.onQueueFull)
                    ? {
                        ...(syncQueue.onQueueChange ? { onQueueChange: syncQueue.onQueueChange } : {}),
                        ...(syncQueue.onQueueFull ? { onQueueFull: (droppedOp: any, maxQueueSize: number) => syncQueue.onQueueFull?.({ maxQueueSize, droppedOp }) } : {})
                    }
                    : undefined,
                queue
            } : {})
        } as any)
        : undefined

    const syncController = createSyncController({
        runtime: clientRuntime,
        backend: resolved.sync.sync,
        localBackend: resolved.store.local,
        syncConfig
    })

    const Store = (<Name extends keyof Entities & string>(name: Name) => {
        const store: any = clientRuntime.Store(name) as any
        if (!('Outbox' in store)) {
            try {
                Object.defineProperty(store, 'Outbox', {
                    enumerable: false,
                    configurable: true,
                    get: () => clientRuntime.SyncStore(name) as any
                })
            } catch {
                store.Outbox = clientRuntime.SyncStore(name) as any
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
