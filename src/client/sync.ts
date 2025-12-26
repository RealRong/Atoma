import type { StoreKey } from '#core'
import { Core } from '#core'
import type { ObservabilityContext } from '#observability'
import { Sync, SyncWriteAck, SyncWriteReject, type SyncClient, type SyncEvent, type SyncPhase } from '../sync'
import type { Change, Cursor, Meta, Operation, OperationResult } from '#protocol'
import { createOpsTransport } from '../adapters/http/transport/ops'
import { StateWriter } from '../adapters/http/state/StateWriter'
import { transformToInstructions } from '../adapters/http/state/transformToInstructions'
import type { AtomaSync } from './types'
import type { ClientPlugin } from './plugins'
import type { ClientRuntime } from './runtime'
import { OutboxPersister } from '../core/mutation/pipeline/persisters/Outbox'
import type { BeforePersistContext, PersistResult } from '../core/mutation/hooks'

export type AtomaClientSyncConfig = {
    enabled?: boolean
    /** ops base URL（例如 '/api' 或 'https://example.com'） */
    baseURL: string
    /** ops endpoint path（默认：'/ops'） */
    opsEndpoint?: string
    /** SSE subscribe endpoint path（默认：'/sync/subscribe-vnext'） */
    subscribeEndpoint?: string
    /** 是否启用 subscribe（默认：true） */
    subscribe?: boolean
    /** SSE event name（默认：Protocol.SSE_EVENT_CHANGES） */
    subscribeEventName?: string
    /** 自定义 subscribeUrl 构造（优先级高于 subscribeEndpoint） */
    subscribeUrl?: (cursor: Cursor) => string
    /** 当 EventSource 不可用或需要自定义时注入 */
    eventSourceFactory?: (url: string) => EventSource
    /** 同步资源过滤（默认：不过滤；服务端返回所有 changes） */
    resources?: string[]
    /** outbox/cursor 存储 key（默认：基于 baseURL 生成） */
    outboxKey?: string
    cursorKey?: string
    maxQueueSize?: number
    maxPushItems?: number
    pullLimit?: number
    reconnectDelayMs?: number
    periodicPullIntervalMs?: number
    inFlightTimeoutMs?: number
    retry?: { maxAttempts?: number }
    backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    lockKey?: string
    lockTtlMs?: number
    lockRenewIntervalMs?: number
    now?: () => number
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    returning?: boolean
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
}

export function createSyncPlugin(args: { syncConfig?: AtomaClientSyncConfig }): ClientPlugin {
    return {
        name: 'sync',
        setup: (runtime: ClientRuntime) => {
            const syncConfig = args.syncConfig
            const syncEnabled = syncConfig?.enabled !== false

            const syncDefaultsKey = syncConfig?.baseURL ? String(syncConfig.baseURL) : 'default'
            const defaultOutboxKey = `atoma:sync:${syncDefaultsKey}:outbox`
            const defaultCursorKey = `atoma:sync:${syncDefaultsKey}:cursor`

            const opsTransport = syncConfig
                ? createOpsTransport({
                    fetchFn: fetch.bind(globalThis),
                    getHeaders: async () => {
                        if (!syncConfig.headers) return {}
                        const headers = syncConfig.headers()
                        return headers instanceof Promise ? await headers : headers
                    }
                })
                : null

            const executeOps = async (runArgs: { ops: Operation[]; meta: Meta }): Promise<OperationResult[]> => {
                if (!syncConfig || !opsTransport) {
                    throw new Error('[Atoma] sync: 未配置（请在 defineClient({ sync: ... }) 中提供 baseURL 等配置）')
                }
                const endpoint = syncConfig.opsEndpoint ?? '/ops'
                const res = await opsTransport.executeOps({
                    url: syncConfig.baseURL,
                    endpoint,
                    ops: runArgs.ops,
                    v: runArgs.meta.v,
                    clientTimeMs: runArgs.meta.clientTimeMs
                })
                return res.results as any
            }

            const buildSubscribeUrl = (cursor: Cursor) => {
                if (!syncConfig) {
                    throw new Error('[Atoma] sync: 未配置 subscribeUrl')
                }
                if (syncConfig.subscribeUrl) return syncConfig.subscribeUrl(cursor)
                const endpoint = syncConfig.subscribeEndpoint ?? '/sync/subscribe-vnext'
                const base = joinUrl(syncConfig.baseURL, endpoint)
                return withCursorParam(base, cursor)
            }

            const applyPullChanges = async (changes: Change[]) => {
                const byResource = new Map<string, Change[]>()
                for (const change of changes) {
                    const list = byResource.get(change.resource)
                    if (list) list.push(change)
                    else byResource.set(change.resource, [change])
                }

                for (const [resource, list] of byResource.entries()) {
                    const store = runtime.resolveStore(resource)
                    const handle = Core.store.getHandle(store)
                    if (!handle) continue

                    handle.services.mutation.control.remotePull({
                        storeName: resource,
                        changes: list
                    })

                    const writer = new StateWriter<any>({
                        getStoreHandle: () => Core.store.getHandle(store) ?? undefined
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

                    const upserts = uniqueUpsertKeys.length
                        ? (await handle.adapter.bulkGet(uniqueUpsertKeys, ctx)).filter((i: any): i is any => i !== undefined)
                        : []

                    const instructions = []
                    if (upserts.length) instructions.push({ kind: 'upsert', items: upserts } as const)
                    if (uniqueDeleteKeys.length) instructions.push({ kind: 'delete', keys: uniqueDeleteKeys } as const)
                    if (!instructions.length) continue

                    await writer.applyInstructions(instructions as any, ctx)
                }
            }

            const applyWriteAck = async (ack: SyncWriteAck) => {
                const store = runtime.resolveStore(ack.resource)
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
                const writer = new StateWriter<any>({ getStoreHandle: () => Core.store.getHandle(store) ?? undefined })
                const ctx = handle.createObservabilityContext?.({}) as any

                const extra: any[] = []
                if (ack.action === 'create') {
                    const tempEntityId = (ack.item as any)?.entityId
                    const nextEntityId = ack.result.entityId

                    const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                        ? normalizeStoreKeyFromEntityId(tempEntityId)
                        : null
                    const nextKey = normalizeStoreKeyFromEntityId(String(nextEntityId))

                    const before = handle.jotaiStore.get(handle.atom) as Map<StoreKey, any>
                    const existing = (tempKey !== null) ? before.get(tempKey) : undefined

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
                        extra.push({ kind: 'upsert', items: [candidate] } as const)
                    }

                    if (tempKey !== null && tempKey !== nextKey) {
                        extra.push({ kind: 'delete', keys: [tempKey] } as const)
                    }
                }

                const base = transformToInstructions({ source: 'syncAck', ack } as any)
                const instructions = [...extra, ...base]
                if (!instructions.length) return
                await writer.applyInstructions(instructions as any, ctx)
            }

            const applyWriteReject = async (
                reject: SyncWriteReject,
                conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
            ) => {
                const store = runtime.resolveStore(reject.resource)
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
                const writer = new StateWriter<any>({ getStoreHandle: () => Core.store.getHandle(store) ?? undefined })
                const ctx = handle.createObservabilityContext?.({}) as any

                const extra: any[] = []
                if (reject.action === 'create') {
                    const tempEntityId = (reject.item as any)?.entityId
                    const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                        ? normalizeStoreKeyFromEntityId(tempEntityId)
                        : null
                    if (tempKey !== null) {
                        extra.push({ kind: 'delete', keys: [tempKey] } as const)
                    }
                }

                const base = transformToInstructions({
                    source: 'syncReject',
                    reject,
                    conflictStrategy
                } as any, { conflictStrategy: syncConfig?.conflictStrategy })
                const instructions = [...extra, ...base]
                if (!instructions.length) return
                await writer.applyInstructions(instructions as any, ctx)
            }

            let syncStarted = false
            let syncEngine: SyncClient | null = null
            const middlewareByStoreName = new Map<string, () => void>()

            const ensureSyncEngine = (): SyncClient => {
                if (syncEngine) return syncEngine
                if (!syncConfig || !syncEnabled) {
                    throw new Error('[Atoma] sync: 未启用或未配置（请在 defineClient({ sync: ... }) 中提供配置）')
                }

                const outboxKey = syncConfig.outboxKey ?? defaultOutboxKey
                const cursorKey = syncConfig.cursorKey ?? defaultCursorKey

                syncEngine = Sync.create({
                    executeOps,
                    subscribeUrl: buildSubscribeUrl,
                    eventSourceFactory: syncConfig.eventSourceFactory,
                    subscribeEventName: syncConfig.subscribeEventName,
                    onPullChanges: applyPullChanges,
                    onWriteAck: applyWriteAck,
                    onWriteReject: applyWriteReject,
                    outboxKey,
                    cursorKey,
                    maxQueueSize: syncConfig.maxQueueSize,
                    maxPushItems: syncConfig.maxPushItems,
                    pullLimit: syncConfig.pullLimit,
                    resources: syncConfig.resources,
                    returning: syncConfig.returning,
                    conflictStrategy: syncConfig.conflictStrategy,
                    subscribe: syncConfig.subscribe !== false,
                    reconnectDelayMs: syncConfig.reconnectDelayMs,
                    periodicPullIntervalMs: syncConfig.periodicPullIntervalMs,
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
                return syncEngine
            }

            const ensureMiddlewareInstalled = (handle: any) => {
                const storeName = String(handle.storeName || 'store')
                if (middlewareByStoreName.has(storeName)) return
                const unsub = handle.services.mutation.hooks.middleware.beforePersist.use(async (
                    ctx: BeforePersistContext<any>,
                    next: (ctx: BeforePersistContext<any>) => Promise<PersistResult<any>>
                ) => {
                    if (!syncStarted) return next(ctx)
                    const engine = ensureSyncEngine()
                    const outbox = new OutboxPersister(engine)
                    await outbox.persist({
                        handle: ctx.handle,
                        operations: ctx.operations,
                        plan: ctx.plan,
                        metadata: ctx.metadata,
                        observabilityContext: ctx.observabilityContext
                    })
                    return { mode: 'outbox', status: 'enqueued' }
                })
                middlewareByStoreName.set(storeName, unsub)
            }

            const unsubscribeHandles = runtime.onHandleCreated((handle) => {
                ensureMiddlewareInstalled(handle as any)
            }, { replay: true })

            const sync: AtomaSync = {
                start: () => {
                    if (syncStarted) return
                    const engine = ensureSyncEngine()
                    syncStarted = true
                    engine.start()
                },
                stop: () => {
                    if (!syncStarted) return
                    syncStarted = false
                    syncEngine?.stop()
                },
                status: () => ({ started: syncStarted, configured: Boolean(syncConfig && syncEnabled) }),
                pullNow: async () => {
                    const engine = ensureSyncEngine()
                    await engine.pullNow()
                },
                flush: async () => {
                    const engine = ensureSyncEngine()
                    await engine.flush()
                }
            }

            return {
                client: { sync },
                dispose: () => {
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
            }
        }
    }
}

function joinUrl(base: string, path: string): string {
    if (!base) return path
    if (!path) return base

    const hasTrailing = base.endsWith('/')
    const hasLeading = path.startsWith('/')

    if (hasTrailing && hasLeading) return `${base}${path.slice(1)}`
    if (!hasTrailing && !hasLeading) return `${base}/${path}`
    return `${base}${path}`
}

function withCursorParam(url: string, cursor: Cursor): string {
    const encoded = encodeURIComponent(String(cursor))
    if (url.includes('?')) return `${url}&cursor=${encoded}`
    return `${url}?cursor=${encoded}`
}

function normalizeStoreKeyFromEntityId(id: string): StoreKey {
    if (/^[0-9]+$/.test(id)) return Number(id)
    return id
}
