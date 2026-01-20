import type { CoreStore, Entity, StoreDataProcessor } from '#core'
import { HistoryController } from '../controllers/HistoryController'
import { SyncController } from '../controllers/SyncController'
import { ClientRuntime } from './createClientRuntime'
import { DefaultCursorStore, DefaultOutboxStore } from '../../../sync/store'
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

const SYNC_INSTANCE_ID_SESSION_KEY = 'atoma:sync:instanceId'

function createSyncInstanceId(): string {
    const cryptoAny = typeof crypto !== 'undefined' ? (crypto as any) : undefined
    const uuid = cryptoAny?.randomUUID?.()
    if (typeof uuid === 'string' && uuid) return `i_${uuid}`
    return `i_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
}

const resolveSyncInstanceId = (() => {
    let fallback: string | undefined

    const safeFallback = () => {
        if (!fallback) fallback = createSyncInstanceId()
        return fallback
    }

    return (): string => {
        if (typeof window === 'undefined') return safeFallback()

        let storage: Storage | undefined
        try {
            storage = window.sessionStorage
        } catch {
            storage = undefined
        }
        if (!storage) return safeFallback()

        try {
            const existing = storage.getItem(SYNC_INSTANCE_ID_SESSION_KEY)
            if (existing && existing.trim()) return existing.trim()
            const next = createSyncInstanceId()
            storage.setItem(SYNC_INSTANCE_ID_SESSION_KEY, next)
            return next
        } catch {
            return safeFallback()
        }
    }
})()

function resolveSyncKeys(args: { backendKey?: string; deviceId?: string }) {
    const syncDefaultsKey = args.backendKey ? String(args.backendKey) : 'default'
    const syncInstanceId = (args.deviceId && String(args.deviceId).trim())
        ? String(args.deviceId).trim()
        : resolveSyncInstanceId()
    const outboxKey = `atoma:sync:${syncDefaultsKey}:${syncInstanceId}:outbox`
    const cursorKey = `atoma:sync:${syncDefaultsKey}:${syncInstanceId}:cursor`
    return {
        outboxKey,
        cursorKey,
        lockKey: `${outboxKey}:lock`
    }
}

export function buildAtomaClient<
    const Entities extends Record<string, Entity>,
    const Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
>(args: {
    schema: Schema
    dataProcessor?: StoreDataProcessor<any>
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

    const syncKeys = syncConfig
        ? resolveSyncKeys({
            backendKey: resolved.sync?.key,
            deviceId: syncConfig.deviceId
        })
        : undefined

    const outboxKey = syncConfig ? (syncConfig.advanced?.outboxKey ?? syncKeys!.outboxKey) : undefined
    const cursorKey = syncConfig ? (syncConfig.advanced?.cursorKey ?? syncKeys!.cursorKey) : undefined
    const lockKey = syncConfig ? (syncConfig.advanced?.lockKey ?? syncKeys!.lockKey) : undefined

    const outboxStore = syncConfig?.queue
        ? new DefaultOutboxStore(
            outboxKey!,
            undefined,
            syncConfig.maxQueueSize ?? 1000,
            syncConfig.now ?? (() => Date.now()),
            syncConfig.inFlightTimeoutMs ?? 30_000,
            syncConfig.queue === 'local-first' ? 'local-first' : 'queue'
        )
        : undefined

    const cursorStore = syncConfig
        ? new DefaultCursorStore(cursorKey!)
        : undefined

    const storeBackend = resolved.store.store

    const clientRuntime = new ClientRuntime({
        schema: args.schema,
        dataProcessor: args.dataProcessor,
        opsClient: storeBackend.opsClient,
        syncStore: {
            queue
        },
        outbox: outboxStore
    })

    const historyController = new HistoryController({ runtime: clientRuntime })

    const syncController = new SyncController({
        runtime: clientRuntime,
        backend: resolved.sync.sync,
        localBackend: resolved.store.local,
        syncConfig,
        outboxStore,
        cursorStore,
        lockKey
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
