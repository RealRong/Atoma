import { Core, OutboxPersister, applyStoreWriteback, type BeforePersistContext, type DeleteItem, type PersistResult, type StoreKey } from '#core'
import { Observability, type ObservabilityContext } from '#observability'
import { Sync, type SyncClient, type SyncEvent, type SyncOutboxEvents, type SyncPhase, type SyncWriteAck, type SyncWriteReject } from '#sync'
import type { Change } from '#protocol'
import type { AtomaClientSyncConfig, ResolvedBackend, AtomaSync } from '../types'
import type { ClientRuntime } from '../runtime'
import { OpsDataSource } from '../../datasources'

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

export function createSyncController(args: {
    runtime: ClientRuntime
    backend?: ResolvedBackend
    localBackend?: ResolvedBackend
    syncConfig?: AtomaClientSyncConfig
}): Readonly<{
    sync: AtomaSync
    dispose: () => void
}> {
    const syncConfig = args.syncConfig
    const syncConfigured = Boolean(syncConfig)

    let syncStarted = false
    let syncEngine: SyncClient | null = null
    let engineModeKey: string | null = null
    const middlewareByStoreName = new Map<string, () => void>()

    let subscribeTraceId: string | undefined
    let subscribeRequestSequencer: ReturnType<typeof Observability.trace.createRequestSequencer> | undefined

    // ---------------------------------------------
    // 1) Public API（新手先看这里）
    // ---------------------------------------------
    const resolveDefaultStartMode = (): 'full' | 'pull+subscribe' | 'pull-only' => {
        const hasQueueWrites = Boolean(syncConfig && (syncConfig as any)?.writePath)
        if (hasQueueWrites) return 'full'
        const wantSubscribe = syncConfig?.subscribe !== false
        const hasSubscribeCapability = Boolean(args.backend?.subscribe || args.backend?.sse?.buildUrl)
        if (wantSubscribe && !hasSubscribeCapability) return 'pull-only'
        if (wantSubscribe) return 'pull+subscribe'
        return 'pull-only'
    }

    const resolveStartMode = (mode?: string): { mode: 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full' } => {
        const m = typeof mode === 'string' && mode ? mode : resolveDefaultStartMode()
        if (m === 'pull-only' || m === 'subscribe-only' || m === 'pull+subscribe' || m === 'push-only' || m === 'full') return { mode: m }
        throw new Error(`[Atoma] Sync.start: unsupported mode (${String(mode)})`)
    }

    const sync: AtomaSync = {
        start: (args) => {
            const { mode } = resolveStartMode(args?.mode)
            const engine = ensureSyncEngine({ mode })
            syncStarted = true
            engine.start()
        },
        stop: () => {
            if (!syncStarted) return
            syncStarted = false
            syncEngine?.stop()
        },
        status: () => ({ started: syncStarted, configured: syncConfigured }),
        pull: async () => {
            if (!syncStarted) {
                sync.start({ mode: 'pull-only' } as any)
            }
            const engine = ensureSyncEngine({ mode: 'pull-only' })
            await engine.pull()
        },
        flush: async () => {
            if (!syncStarted) {
                sync.start({ mode: 'push-only' } as any)
            }
            const engine = ensureSyncEngine({ mode: 'push-only' })
            await engine.flush()
        },
        setSubscribed: (enabled: boolean) => {
            const engine = ensureSyncEngine({ mode: 'pull+subscribe' })
            engine.setSubscribed(Boolean(enabled))
        }
    }

    // ---------------------------------------------
    // 2) Middleware（direct -> outbox 的切换点）
    // ---------------------------------------------
    async function persistOrNext(
        ctx: BeforePersistContext<any>,
        next: (ctx: BeforePersistContext<any>) => Promise<PersistResult<any>>
    ): Promise<PersistResult<any>> {
        const ops = Array.isArray(ctx.operations) ? ctx.operations : []
        const persistModeSet = new Set<string>()
        for (const op of ops) {
            const mode = (op as any)?.__persist
            if (mode === 'outbox' || mode === 'direct') {
                persistModeSet.add(mode)
            }
        }

        // 默认 direct：不做任何拦截
        if (!persistModeSet.size || (persistModeSet.size === 1 && persistModeSet.has('direct'))) {
            return next(ctx)
        }

        if (persistModeSet.size > 1) {
            throw new Error('[Atoma] mixed persist modes in one mutation segment (direct vs outbox)')
        }

        const types = ctx?.plan?.operationTypes
        if (Array.isArray(types) && types.includes('create' as any)) {
            throw new Error('[Atoma] createServerAssigned* 不支持 outbox（Server-ID create 必须 direct + strict，且禁止 outbox）')
        }

        const writePath = (syncConfig && typeof syncConfig === 'object' && !Array.isArray(syncConfig) && typeof (syncConfig as any).writePath === 'string')
            ? String((syncConfig as any).writePath)
            : 'queue-only'

        let localPersist: PersistResult<any> | undefined
        if (writePath === 'save-local-then-queue') {
            localPersist = await next(ctx)
        }

        const engine = ensureSyncEngine({ mode: 'enqueue-only' })
        const outbox = new OutboxPersister(engine)
        await outbox.persist({
            handle: ctx.handle,
            operations: ctx.operations,
            plan: ctx.plan,
            metadata: ctx.metadata,
            observabilityContext: ctx.observabilityContext
        })
        return {
            mode: 'outbox',
            status: 'enqueued',
            ...(localPersist?.writeback ? { writeback: localPersist.writeback } : {}),
            ...(localPersist?.created ? { created: localPersist.created } : {})
        }
    }

    function installBeforePersist(handle: any): void {
        const storeName = String(handle.storeName || 'store')
        if (middlewareByStoreName.has(storeName)) return
        const unsub = handle.services.mutation.hooks.middleware.beforePersist.use(persistOrNext)
        middlewareByStoreName.set(storeName, unsub)
    }

    // 覆盖：已创建 + 未来创建的 handle（replay: true）
    const unsubscribeHandles = args.runtime.onHandleCreated((handle) => {
        installBeforePersist(handle as any)
    }, { replay: true })

    // ---------------------------------------------
    // 3) Engine（只做构造与缓存）
    // ---------------------------------------------
    const syncDefaultsKey = args.backend?.key ? String(args.backend.key) : 'default'
    const syncInstanceId = resolveSyncInstanceId()
    const defaultOutboxKey = `atoma:sync:${syncDefaultsKey}:${syncInstanceId}:outbox`
    const defaultCursorKey = `atoma:sync:${syncDefaultsKey}:${syncInstanceId}:cursor`

    function ensureSyncEngine(args2?: { mode?: 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full' | 'enqueue-only' }): SyncClient {
        const mode = args2?.mode ?? 'full'
        const key = String(mode)
        if (syncEngine && engineModeKey === key) return syncEngine

        if (syncEngine && engineModeKey !== key) {
            try {
                syncEngine.stop()
            } catch {
                // ignore
            }
            try {
                syncEngine.dispose()
            } catch {
                // ignore
            }
            syncEngine = null
            engineModeKey = null
        }

        if (!syncConfig) {
            throw new Error('[Atoma] sync: 未配置（请通过 builder 配置 sync.target / sync.defaults / sync.queueWrites）')
        }
        if (!args.backend) {
            throw new Error('[Atoma] sync: 未配置同步对端（sync.target）')
        }

        const outboxKey = syncConfig.outboxKey ?? defaultOutboxKey
        const cursorKey = syncConfig.cursorKey ?? defaultCursorKey

        const backend = args.backend

        const modeConfig = (() => {
            if (mode === 'enqueue-only') {
                return { push: false, pull: false, subscribe: false, periodicPullIntervalMs: 0 }
            }
            if (mode === 'pull-only') {
                return { push: false, pull: true, subscribe: false }
            }
            if (mode === 'subscribe-only') {
                return { push: false, pull: true, subscribe: true, periodicPullIntervalMs: 0 }
            }
            if (mode === 'pull+subscribe') {
                return { push: false, pull: true, subscribe: true }
            }
            if (mode === 'push-only') {
                return { push: true, pull: false, subscribe: false, periodicPullIntervalMs: 0 }
            }
            return { push: true, pull: true, subscribe: true }
        })()

        const wantsSubscribe = modeConfig.subscribe && syncConfig.subscribe !== false
        if (wantsSubscribe && !backend.subscribe && !backend.sse?.buildUrl) {
            throw new Error('[Atoma] sync: subscribe 已启用，但 backend 未提供 subscribe 能力（请提供 backend.http.subscribePath/subscribeUrl、backend.sse 或 backend.subscribe）')
        }

        const transport = {
            opsClient: backend.opsClient,
            subscribe: backend.subscribe
                ? backend.subscribe
                : (subArgs: { resources?: string[]; onMessage: (msg: any) => void; onError: (error: unknown) => void }) => {
                    return Sync.subscribeNotifySse({
                        resources: subArgs.resources,
                        buildUrl: buildSubscribeUrl,
                        eventSourceFactory: backend.sse?.eventSourceFactory,
                        eventName: syncConfig.subscribeEventName,
                        onMessage: subArgs.onMessage,
                        onError: subArgs.onError
                    })
                }
        }

        syncEngine = Sync.create({
            transport,
            push: modeConfig.push,
            pull: modeConfig.pull,
            onPullChanges: applyPullChanges,
            onWriteAck: applyWriteAck,
            onWriteReject: applyWriteReject,
            outboxKey,
            cursorKey,
            maxQueueSize: syncConfig.maxQueueSize,
            outboxEvents: syncConfig.outboxEvents,
            maxPushItems: syncConfig.maxPushItems,
            pullLimit: syncConfig.pullLimit,
            pullDebounceMs: syncConfig.pullDebounceMs,
            resources: syncConfig.resources,
            returning: syncConfig.returning,
            conflictStrategy: syncConfig.conflictStrategy,
            subscribe: wantsSubscribe,
            reconnectDelayMs: syncConfig.reconnectDelayMs,
            periodicPullIntervalMs: typeof modeConfig.periodicPullIntervalMs === 'number'
                ? modeConfig.periodicPullIntervalMs
                : syncConfig.periodicPullIntervalMs,
            inFlightTimeoutMs: syncConfig.inFlightTimeoutMs,
            retry: syncConfig.retry,
            backoff: syncConfig.backoff,
            lockKey: syncConfig.lockKey,
            lockTtlMs: syncConfig.lockTtlMs,
            lockRenewIntervalMs: syncConfig.lockRenewIntervalMs,
            now: syncConfig.now,
            onError: syncConfig.onError,
            onEvent: syncConfig.onEvent
        })
        engineModeKey = key
        return syncEngine
    }

    // ---------------------------------------------
    // 4) Writeback（把 pull/ack/reject 写回本地）
    // ---------------------------------------------
    const createRemoteDataSource = (resource: string) => {
        const backend = args.backend
        if (!backend) return null
        return new OpsDataSource<any>({
            opsClient: backend.opsClient,
            resourceName: resource,
            name: `${backend.key}:remote`,
            batch: false
        })
    }

    const createLocalDataSource = (resource: string) => {
        const backend = args.localBackend
        if (!backend) return null
        return new OpsDataSource<any>({
            opsClient: backend.opsClient,
            resourceName: resource,
            name: `${backend.key}:local`,
            batch: false
        })
    }

    const persistToLocal = async (resource: string, args2: { upserts?: any[]; deletes?: StoreKey[]; versionUpdates?: Array<{ key: StoreKey; version: number }> }) => {
        const local = createLocalDataSource(resource)
        if (!local) return

        const upserts = Array.isArray(args2.upserts) ? args2.upserts : []
        const deletes = Array.isArray(args2.deletes) ? args2.deletes : []
        const versionUpdates = Array.isArray(args2.versionUpdates) ? args2.versionUpdates : []

        if (upserts.length) {
            await local.bulkUpsert(upserts as any[], { mode: 'loose', merge: false })
        }
        if (deletes.length) {
            const current = await local.bulkGet(deletes)
            const deleteItems: DeleteItem[] = []
            for (let i = 0; i < deletes.length; i++) {
                const id = deletes[i]
                const row = current[i]
                if (!row || typeof row !== 'object') continue
                const baseVersion = (row as any).version
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                    throw new Error(`[Atoma] local delete requires baseVersion (missing version for id=${String(id)})`)
                }
                deleteItems.push({ id, baseVersion })
            }
            if (deleteItems.length) {
                await local.bulkDelete(deleteItems)
            }
        }

        if (versionUpdates.length) {
            const versionByKey = new Map<StoreKey, number>()
            versionUpdates.forEach(v => versionByKey.set(v.key, v.version))

            const upsertedKeys = new Set<StoreKey>()
            upserts.forEach(u => {
                const id = (u as any)?.id
                if (id !== undefined) upsertedKeys.add(id)
            })

            const toUpdate = Array.from(versionByKey.entries())
                .filter(([key]) => !upsertedKeys.has(key))
                .map(([key]) => key)

            if (toUpdate.length) {
                const current = await local.bulkGet(toUpdate)
                const patched: any[] = []
                for (let i = 0; i < toUpdate.length; i++) {
                    const key = toUpdate[i]
                    const row = current[i]
                    const nextVersion = versionByKey.get(key)
                    if (!row || nextVersion === undefined) continue
                    if (row && typeof row === 'object') {
                        patched.push({ ...(row as any), version: nextVersion })
                    }
                }
                if (patched.length) {
                    await local.bulkPut(patched)
                }
            }
        }
    }

    async function applyPullChanges(changes: Change[]): Promise<void> {
        const byResource = new Map<string, Change[]>()
        for (const change of changes) {
            const list = byResource.get(change.resource)
            if (list) list.push(change)
            else byResource.set(change.resource, [change])
        }

        for (const [resource, list] of byResource.entries()) {
            const store = args.runtime.resolveStore(resource)
            const handle = Core.store.getHandle(store)
            if (!handle) continue

            handle.services.mutation.control.remotePull({
                storeName: resource,
                changes: list
            })

            const deleteKeys: StoreKey[] = []
            const upsertEntityIds: string[] = []

            for (const c of list) {
                if (c.kind === 'delete') {
                    deleteKeys.push(normalizeStoreKeyFromEntityId(String(c.entityId)))
                    continue
                }
                upsertEntityIds.push(String(c.entityId))
            }

            const uniqueUpsertKeys = Array.from(new Set(upsertEntityIds)).map(id => normalizeStoreKeyFromEntityId(id))
            const uniqueDeleteKeys = Array.from(new Set(deleteKeys))

            const ctx: ObservabilityContext = handle.createObservabilityContext
                ? handle.createObservabilityContext({})
                : (undefined as any)

            const remote = createRemoteDataSource(resource)
            const upserts = (remote && uniqueUpsertKeys.length)
                ? (await remote.bulkGet(uniqueUpsertKeys, ctx)).filter((i: any): i is any => i !== undefined)
                : []

            await applyStoreWriteback(handle as any, {
                upserts,
                deletes: uniqueDeleteKeys
            })

            await persistToLocal(resource, {
                upserts,
                deletes: uniqueDeleteKeys
            })
        }
    }

    async function applyWriteAck(ack: SyncWriteAck): Promise<void> {
        const store = args.runtime.resolveStore(ack.resource)
        const handle = Core.store.getHandle(store)
        if (!handle) return
        const key = (ack.item as any)?.meta && typeof (ack.item as any).meta === 'object'
            ? (ack.item as any).meta.idempotencyKey
            : undefined
        handle.services.mutation.control.remoteAck({
            storeName: ack.resource,
            idempotencyKey: (typeof key === 'string' && key) ? key : undefined,
            ack
        })

        const upserts: any[] = []
        const deletes: StoreKey[] = []
        const versionUpdates: Array<{ key: StoreKey; version: number }> = []

        const version = ack.result.version
        if (typeof version === 'number' && Number.isFinite(version)) {
            versionUpdates.push({ key: normalizeStoreKeyFromEntityId(String(ack.result.entityId)), version })
        }

        if (ack.action === 'create') {
            const nextEntityId = ack.result.entityId
            const nextKey = normalizeStoreKeyFromEntityId(String(nextEntityId))

            const tempEntityId = (ack.item as any)?.entityId
            const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                ? normalizeStoreKeyFromEntityId(tempEntityId)
                : null

            if (tempKey !== null && tempKey !== nextKey) {
                throw new Error('[Atoma] sync: create ack returned mismatched id (client-id create must not change id)')
            }

            const before = handle.jotaiStore.get(handle.atom) as Map<StoreKey, any>
            const existing = before.get(nextKey)

            const serverData = ack.result.data
            const candidate = (serverData && typeof serverData === 'object')
                ? { ...(serverData as any) }
                : (existing && typeof existing === 'object')
                    ? { ...(existing as any) }
                    : undefined

            if (candidate) {
                candidate.id = nextKey as any
                if (typeof ack.result.version === 'number' && Number.isFinite(ack.result.version)) {
                    candidate.version = ack.result.version
                }
                upserts.push(candidate)
            }
        }

        await applyStoreWriteback(handle as any, {
            upserts,
            deletes,
            versionUpdates
        })

        await persistToLocal(ack.resource, {
            upserts,
            deletes,
            versionUpdates
        })
    }

    async function applyWriteReject(
        reject: SyncWriteReject,
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    ): Promise<void> {
        const store = args.runtime.resolveStore(reject.resource)
        const handle = Core.store.getHandle(store)
        if (!handle) return
        const key = (reject.item as any)?.meta && typeof (reject.item as any).meta === 'object'
            ? (reject.item as any).meta.idempotencyKey
            : undefined
        handle.services.mutation.control.remoteReject({
            storeName: reject.resource,
            idempotencyKey: (typeof key === 'string' && key) ? key : undefined,
            reject,
            reason: (reject.result as any)?.error ?? reject.result
        })
        const upserts: any[] = []
        const deletes: StoreKey[] = []

        if (reject.action === 'create') {
            const tempEntityId = (reject.item as any)?.entityId
            const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                ? normalizeStoreKeyFromEntityId(tempEntityId)
                : null
            if (tempKey !== null) {
                deletes.push(tempKey)
            }
        }

        const strategy = conflictStrategy ?? syncConfig?.conflictStrategy ?? 'server-wins'
        const error = (reject.result as any)?.error
        const current = (reject.result as any)?.current
        if (error?.code === 'CONFLICT' && current?.value && strategy === 'server-wins') {
            upserts.push(current.value)
        }

        await applyStoreWriteback(handle as any, { upserts, deletes })

        await persistToLocal(reject.resource, { upserts, deletes })
    }

    function buildSubscribeUrl(args2?: { resources?: string[] }): string {
        const backend = args.backend
        if (!backend?.sse?.buildUrl) {
            throw new Error('[Atoma] sync: subscribe 已启用，但 backend 未配置 SSE subscribeUrl')
        }
        const base = backend.sse.buildUrl({ resources: args2?.resources })

        if (!subscribeTraceId) {
            subscribeTraceId = Observability.trace.createId()
        }
        if (!subscribeRequestSequencer) {
            subscribeRequestSequencer = Observability.trace.createRequestSequencer()
        }

        const requestId = subscribeRequestSequencer.next(subscribeTraceId)
        return withQueryParams(base, { traceId: subscribeTraceId, requestId })
    }

    // ---------------------------------------------
    // 6) Dispose
    // ---------------------------------------------
    const dispose = () => {
        try {
            sync.stop()
        } catch {
            // ignore
        }
        unsubscribeHandles()
        for (const unsub of middlewareByStoreName.values()) {
            try {
                unsub()
            } catch {
                // ignore
            }
        }
    }

    return {
        sync,
        dispose
    }
}

function withQueryParams(url: string, params: { traceId: string; requestId: string }): string {
    const t = encodeURIComponent(params.traceId)
    const r = encodeURIComponent(params.requestId)
    const join = url.includes('?') ? '&' : '?'
    return `${url}${join}traceId=${t}&requestId=${r}`
}

function normalizeStoreKeyFromEntityId(id: string): StoreKey {
    if (/^[0-9]+$/.test(id)) return Number(id)
    return id
}
