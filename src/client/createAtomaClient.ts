import type { CoreStore, Entity } from '#core'
import { createHistoryController } from './controllers/HistoryController'
import { createSyncController } from './controllers/SyncController'
import { createClientRuntime } from './runtime'
import type {
    AtomaClient,
    AtomaSchema,
    BackendConfig,
    BackendEndpointConfig,
    StoreBackendState,
    StoreBackendEndpointConfig,
    StoreBatchArgs,
    SyncDefaultsArgs,
    SyncQueueWriteMode,
    SyncQueueWritesArgs
} from './types'
import { resolveBackend } from './backend'
import { OpsDataSource } from '../datasources'

export function createAtomaClientInternal<
    const Entities extends Record<string, Entity>,
    const Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
>(args: {
    schema: Schema
    storeBackend: StoreBackendState
    storeBatch?: StoreBatchArgs
    syncTarget?: BackendEndpointConfig
    syncDefaults?: SyncDefaultsArgs
    syncQueueWrites?: SyncQueueWritesArgs
    syncQueueWriteMode?: SyncQueueWriteMode
}): AtomaClient<Entities, Schema> {
    const storeBackend = args.storeBackend
    const syncQueue = args.syncQueueWrites
    const defaults = args.syncDefaults

    const wantsSync = Boolean(args.syncTarget || syncQueue || defaults)

    const derivedSyncTarget = (!args.syncTarget && storeBackend.role === 'remote')
        ? storeBackend.backend
        : undefined

    const syncTarget: BackendConfig | undefined = args.syncTarget ?? derivedSyncTarget

    if (wantsSync && !syncTarget) {
        throw new Error('[Atoma] createClient: 使用 sync 相关配置前必须先配置 sync 对端（sync.url/sync.backend），或将 store.type 设为 http/custom(remote) 以复用 store 对端')
    }

    const queueWriteMode: SyncQueueWriteMode | undefined = syncQueue
        ? (args.syncQueueWriteMode ?? (storeBackend.role === 'local' ? 'local-first' : 'intent-only'))
        : undefined

    if (queueWriteMode === 'local-first' && storeBackend.role !== 'local') {
        throw new Error('[Atoma] createClient: sync.queue=\"local-first\" 需要 store 为本地 durable（indexeddb/localServer/custom local）')
    }

    const resolved = (() => {
        if (storeBackend.role === 'local') {
            const remote = args.syncTarget
            const config: BackendConfig = remote
                ? { local: storeBackend.backend, remote }
                : storeBackend.backend
            const backends = resolveBackend(config)
            return {
                store: backends,
                sync: backends
            }
        }

        const store = resolveBackend(storeBackend.backend)
        const sync = syncTarget ? resolveBackend(syncTarget) : store
        return { store, sync }
    })()

    if (wantsSync && !resolved.sync?.sync) {
        throw new Error('[Atoma] createClient: sync 对端必须支持同步（需要 remote opsClient 能力）')
    }

    const dataSourceBackend = resolved.store.dataSource
    const dataSourceFactory = ((resourceName: string) => {
        return new OpsDataSource<any>({
            opsClient: dataSourceBackend.opsClient,
            name: dataSourceBackend.key,
            resourceName,
            batch: args.storeBatch ?? false
        })
    })

    const runtime = createClientRuntime({
        schema: args.schema,
        defaults: {
            dataSourceFactory: dataSourceFactory as any
        },
        syncStore: {
            mode: queueWriteMode
        }
    })

    const historyController = createHistoryController({ runtime })

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
            periodicPullIntervalMs: defaults?.periodicPullIntervalMs,
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
                maxQueueSize: syncQueue.maxSize,
                outboxEvents: (syncQueue.onQueueChange || syncQueue.onQueueFull)
                    ? {
                        ...(syncQueue.onQueueChange ? { onQueueChange: syncQueue.onQueueChange } : {}),
                        ...(syncQueue.onQueueFull ? { onQueueFull: (droppedOp: any, maxSize: number) => syncQueue.onQueueFull?.({ maxSize, droppedOp }) } : {})
                    }
                    : undefined,
                queueWriteMode
            } : {})
        } as any)
        : undefined

    const syncController = createSyncController({
        runtime,
        backend: resolved.sync.sync,
        localBackend: resolved.store.local,
        syncConfig
    })

    const Store = (<Name extends keyof Entities & string>(name: Name) => {
        return runtime.Store(name) as unknown as CoreStore<Entities[Name], any>
    }) as AtomaClient<Entities, Schema>['Store']

    const Sync = {
        ...syncController.sync,
        Store: (<Name extends keyof Entities & string>(name: Name) => {
            return runtime.SyncStore(name) as any
        }) as AtomaClient<Entities, Schema>['Sync']['Store']
    } as AtomaClient<Entities, Schema>['Sync']

    const client: AtomaClient<Entities, Schema> = {
        Store,
        Sync,
        History: historyController.history
    }

    // Devtools Inspector: auto-register client when global devtools is enabled.
    // - No public API added to AtomaClient.
    // - Hook is installed by `devtools.enableGlobal()` from `atoma/devtools`.
    const devtoolsHook = (globalThis as any)?.__ATOMA_DEVTOOLS__
    if (devtoolsHook && typeof devtoolsHook.registerClient === 'function') {
        const kind = (() => {
            const b: any = storeBackend.backend
            if (typeof b === 'string') return 'http' as const
            if (b && typeof b === 'object' && !Array.isArray(b)) {
                if ('indexeddb' in b) return 'indexeddb' as const
                if ('memory' in b) return 'memory' as const
                if ('opsClient' in b) return 'custom' as const
                if ('http' in b) return (storeBackend.role === 'local' ? 'localServer' : 'http') as 'localServer' | 'http'
            }
            return 'custom' as const
        })()

        try {
            devtoolsHook.registerClient({
                client,
                runtime,
                syncDevtools: syncController.devtools,
                historyDevtools: historyController.devtools,
                meta: {
                    storeBackend: {
                        role: storeBackend.role,
                        kind
                    },
                    syncConfigured: wantsSync
                }
            })
        } catch {
            // ignore
        }
    }

    return client
}
