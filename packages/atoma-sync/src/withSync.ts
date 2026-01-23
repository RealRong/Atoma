import type { ClientPlugin, ClientPluginContext, PluginCapableClient } from 'atoma/client'
import type { Entity, PersistRequest, PersistResult } from 'atoma/core'
import { Backend } from 'atoma/backend'
import { Protocol, type Change, type EntityId, type Meta, type Operation, type OperationResult, type QueryParams, type QueryResultData, type WriteAction, type WriteItem, type WriteItemMeta, type WriteOptions, type WriteResultData } from 'atoma/protocol'
import { Shared } from 'atoma/shared'
import { SyncEngine } from '#sync/engine/SyncEngine'
import { createOpsTransport } from '#sync/transport/opsTransport'
import { subscribeNotifySse } from '#sync/transport/sseNotify'
import { createStores } from '#sync/store'
import type { OutboxWrite, SyncApplier, SyncClient, SyncMode, SyncOutboxEvents, SyncOutboxStats, SyncPhase, SyncRuntimeConfig, SyncTransport, SyncWriteAck, SyncWriteReject } from '#sync/types'

export type WithSyncOptions = Readonly<{
    /**
     * Remote endpoint used for pull/push/subscribe.
     * - `sse` is an optional path or absolute URL for notify subscribe.
     */
    endpoint: Readonly<{
        url: string
        sse?: string
        http?: Readonly<{
            opsPath?: string
            headers?: () => Promise<Record<string, string>> | Record<string, string>
            retry?: import('atoma/backend').RetryOptions
            fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
            onRequest?: (request: Request) => Promise<Request | void> | Request | void
            onResponse?: (context: {
                response: Response
                envelope: import('atoma/protocol').Envelope<import('atoma/protocol').OpsResponseData>
                request: Request
            }) => void
            responseParser?: (response: Response, data: unknown) => Promise<import('atoma/protocol').Envelope<import('atoma/protocol').OpsResponseData>> | import('atoma/protocol').Envelope<import('atoma/protocol').OpsResponseData>
        }>
        subscribe?: Readonly<{
            connect?: (url: string) => EventSource
            eventName?: string
        }>
    }>

    mode?: SyncMode
    resources?: string[]

    outbox?: false | Readonly<{
        mode?: 'queue' | 'local-first'
        storage?: Readonly<{ maxSize?: number; inFlightTimeoutMs?: number }>
        events?: SyncOutboxEvents
    }>

    state?: Readonly<{
        deviceId?: string
        keys?: Readonly<{ outbox?: string; cursor?: string; lock?: string }>
        lock?: Readonly<{ ttlMs?: number; renewIntervalMs?: number }>
    }>

    engine?: Readonly<{
        pull?: Readonly<{ limit?: number; debounceMs?: number; intervalMs?: number }>
        push?: Readonly<{ maxItems?: number; returning?: boolean; conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual' }>
        subscribe?: Readonly<{ enabled?: boolean; reconnectDelayMs?: number }>
        retry?: Readonly<{ maxAttempts?: number }>
        backoff?: Readonly<{ baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }>
        now?: () => number
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: any) => void
    }>
}>

export type WithSyncExtension = Readonly<{
    sync: {
        start: (mode?: SyncMode) => void
        stop: () => void
        dispose: () => void
        status: () => { started: boolean; configured: boolean }
        pull: () => Promise<void>
        push: () => Promise<void>
        devtools: { snapshot: () => any; subscribe: (fn: (e: any) => void) => () => void }
    }
}>

export function withSync<TClient extends PluginCapableClient>(client: TClient, opts: WithSyncOptions): TClient & WithSyncExtension {
    return client.use(syncPlugin(opts)) as any
}

export function syncPlugin(opts: WithSyncOptions): ClientPlugin<WithSyncExtension> {
    return {
        name: 'sync',
        setup: (ctx) => setupSyncPlugin(ctx, opts)
    }
}

function setupSyncPlugin(ctx: ClientPluginContext, opts: WithSyncOptions): { extension: WithSyncExtension; dispose: () => void } {
    const client: any = ctx.client as any

    const now = opts.engine?.now ?? (() => Date.now())
    const modeDefault: SyncMode = opts.mode ?? 'full'
    const resources = opts.resources

    const endpointUrl = String(opts.endpoint.url)
    if (!endpointUrl) throw new Error('[atoma-sync] withSync: endpoint.url 必填')

    const deviceId = String(opts.state?.deviceId ?? defaultDeviceId())
    const keys = opts.state?.keys ?? {}
    const keyOutbox = String(keys.outbox ?? `atoma-sync:${deviceId}:outbox`)
    const keyCursor = String(keys.cursor ?? `atoma-sync:${deviceId}:cursor`)
    const keyLock = String(keys.lock ?? `atoma-sync:${deviceId}:lock`)

    const outboxCfg = opts.outbox
    const outboxEnabled = outboxCfg !== false
    const outboxConfig = outboxCfg === false ? {} : (outboxCfg ?? {})
    const outboxMode = outboxConfig.mode === 'local-first' ? 'local-first' : 'queue'

    const stores = createStores({
        outboxKey: keyOutbox,
        cursorKey: keyCursor,
        queueEnabled: outboxEnabled,
        queueMode: outboxMode,
        maxQueueSize: outboxEnabled ? (outboxConfig.storage?.maxSize ?? 1000) : 0,
        inFlightTimeoutMs: outboxEnabled ? (outboxConfig.storage?.inFlightTimeoutMs ?? 30_000) : undefined,
        outboxEvents: outboxEnabled ? outboxConfig.events : undefined,
        now
    })

    const remoteOpsClient = new Backend.Ops.HttpOpsClient({
        baseURL: endpointUrl,
        opsPath: opts.endpoint.http?.opsPath ?? Protocol.http.paths.OPS,
        headers: opts.endpoint.http?.headers,
        retry: opts.endpoint.http?.retry,
        fetchFn: opts.endpoint.http?.fetchFn,
        interceptors: {
            onRequest: opts.endpoint.http?.onRequest,
            onResponse: opts.endpoint.http?.onResponse,
            responseParser: opts.endpoint.http?.responseParser
        }
    })

    const subscribe = (() => {
        const sse = opts.endpoint.sse
        if (!sse) return undefined

        const buildUrl = (args2: { resources?: string[] }) => Shared.url.withResourcesParam(
            Shared.url.resolveUrl(endpointUrl, String(sse)),
            args2.resources
        )

        return (args2: { resources?: string[]; onMessage: (msg: any) => void; onError: (error: unknown) => void; signal?: AbortSignal }) => {
            return subscribeNotifySse({
                resources: args2.resources,
                buildUrl,
                connect: opts.endpoint.subscribe?.connect,
                eventName: opts.endpoint.subscribe?.eventName,
                onMessage: args2.onMessage,
                onError: args2.onError,
                signal: args2.signal
            })
        }
    })()

    const transport: SyncTransport = createOpsTransport({
        opsClient: remoteOpsClient,
        ...(subscribe ? { subscribe } : {}),
        now
    })

    const devtoolsSubscribers = new Set<(e: any) => void>()
    const emitDevtools = (e: any) => {
        for (const fn of devtoolsSubscribers) {
            try {
                fn(e)
            } catch {
                // ignore
            }
        }
    }

    let lastEventAt: number | undefined
    let lastError: string | undefined
    let lastOutboxStats: SyncOutboxStats | undefined
    let started = false

    const onEvent = (e: any) => {
        lastEventAt = now()
        if (e?.type === 'outbox:queue') lastOutboxStats = e.stats
        if (e?.type === 'outbox:queue_full') lastOutboxStats = e.stats
        if (e?.type === 'lifecycle:started') started = true
        if (e?.type === 'lifecycle:stopped') started = false
        emitDevtools({ type: String(e?.type ?? 'event'), payload: e })
        opts.engine?.onEvent?.(e)
    }

    const onError = (error: Error, context: { phase: SyncPhase }) => {
        lastError = error?.message ? String(error.message) : 'Unknown error'
        emitDevtools({ type: 'error', payload: { error: lastError, context } })
        opts.engine?.onError?.(error, context)
    }

    const shouldPersistToLocal = ctx.meta?.storeBackend?.role === 'local'

    const applier: SyncApplier = new WritebackApplier({
        ctx,
        remoteOpsClient,
        localOpsClient: shouldPersistToLocal ? ctx.runtime.opsClient : undefined,
        conflictStrategy: opts.engine?.push?.conflictStrategy,
        now
    })

    const engineConfigForMode = (m: SyncMode): SyncRuntimeConfig => {
        const pullEnabled = m === 'pull-only' || m === 'pull+subscribe' || m === 'full'
        const subscribeEnabled = m === 'subscribe-only' || m === 'pull+subscribe' || m === 'full'
        const pushEnabled = m === 'push-only' || m === 'full'

        const pullIntervalMs = Math.max(0, Math.floor(opts.engine?.pull?.intervalMs ?? 10_000))
        const pullLimit = Math.max(1, Math.floor(opts.engine?.pull?.limit ?? 200))
        const debounceMs = Math.max(0, Math.floor(opts.engine?.pull?.debounceMs ?? 300))

        const maxItems = Math.max(1, Math.floor(opts.engine?.push?.maxItems ?? 50))
        const returning = Boolean(opts.engine?.push?.returning ?? false)

        const reconnectDelayMs = Math.max(200, Math.floor(opts.engine?.subscribe?.reconnectDelayMs ?? 1000))

        const retry = opts.engine?.retry ?? {}
        const backoff = opts.engine?.backoff ?? {}

        return {
            transport,
            applier,
            ...(stores.outbox ? { outbox: stores.outbox } : {}),
            cursor: stores.cursor,
            ...(stores.outbox ? { outboxEvents: outboxEnabled ? outboxConfig.events : undefined } : {}),

            push: {
                enabled: pushEnabled && Boolean(stores.outbox),
                maxItems,
                returning,
                ...(opts.engine?.push?.conflictStrategy ? { conflictStrategy: opts.engine.push.conflictStrategy } : {}),
                retry,
                backoff
            },

            pull: {
                enabled: pullEnabled,
                limit: pullLimit,
                debounceMs,
                ...(resources?.length ? { resources } : {}),
                periodic: {
                    intervalMs: pullIntervalMs,
                    retry,
                    backoff
                }
            },

            subscribe: {
                enabled: Boolean(subscribe) && subscribeEnabled,
                reconnectDelayMs,
                retry,
                backoff
            },

            lock: {
                key: keyLock,
                ttlMs: opts.state?.lock?.ttlMs,
                renewIntervalMs: opts.state?.lock?.renewIntervalMs,
                backoff
            },

            now,
            onEvent,
            onError
        }
    }

    let currentMode: SyncMode = modeDefault
    let engine: SyncClient | null = null

    const ensureEngine = (m: SyncMode) => {
        if (engine && currentMode === m) return engine
        engine?.dispose()
        currentMode = m
        engine = new SyncEngine(engineConfigForMode(m))
        return engine
    }

    // Register persist handlers for the outbox store views.
    const unregister: Array<() => void> = []
    if (outboxEnabled) {
        unregister.push(ctx.persistence.register('sync:queue', async <T extends Entity>(args2: {
            req: PersistRequest<T>
            next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
        }) => {
            if (!stores.outbox) throw new Error('[atoma-sync] outbox disabled')
            const writes = mapTranslatedWriteOpsToOutboxWrites(args2.req.writeOps)
            if (writes.length) await stores.outbox.enqueueWrites({ writes })
            return { status: 'enqueued' } as PersistResult<T>
        }))

        unregister.push(ctx.persistence.register('sync:local-first', async <T extends Entity>(args2: {
            req: PersistRequest<T>
            next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
        }) => {
            if (!stores.outbox) throw new Error('[atoma-sync] outbox disabled')
            const direct = await args2.next(args2.req)
            const writes = mapTranslatedWriteOpsToOutboxWrites(args2.req.writeOps)
            if (writes.length) await stores.outbox.enqueueWrites({ writes })
            return { status: 'enqueued', ...(direct.created ? { created: direct.created } : {}), ...(direct.writeback ? { writeback: direct.writeback } : {}) } as PersistResult<T>
        }))
    }

    // Optional: attach store view for queued writes.
    const originalStoreFn = typeof client?.Store === 'function' ? client.Store.bind(client) : null
    if (originalStoreFn && ctx.stores?.view && outboxEnabled) {
        const persistKey = outboxMode === 'local-first' ? 'sync:local-first' : 'sync:queue'
        const allowImplicitFetchForWrite = outboxMode === 'queue' ? false : undefined

        client.Store = (name: string) => {
            const base = originalStoreFn(name)
            if (base && typeof base === 'object' && !('Outbox' in base)) {
                try {
                    Object.defineProperty(base, 'Outbox', {
                        enumerable: false,
                        configurable: true,
                        get: () => ctx.stores!.view(base, {
                            persistKey,
                            allowImplicitFetchForWrite,
                            includeServerAssignedCreate: false
                        })
                    })
                } catch {
                    ;(base as any).Outbox = ctx.stores!.view(base, {
                        persistKey,
                        allowImplicitFetchForWrite,
                        includeServerAssignedCreate: false
                    })
                }
            }
            return base
        }
    }

    const sync = {
        start: (m?: SyncMode) => {
            const selected = m ?? modeDefault
            ensureEngine(selected).start()
        },
        stop: () => {
            engine?.stop()
        },
        dispose: () => {
            engine?.dispose()
            engine = null
        },
        status: () => {
            return { started, configured: true }
        },
        pull: async () => {
            const e = ensureEngine(currentMode)
            await e.pull()
        },
        push: async () => {
            const e = ensureEngine(currentMode)
            await e.flush()
        },
        devtools: {
            snapshot: () => ({
                status: { configured: true, started },
                ...(lastOutboxStats ? { queue: { pending: lastOutboxStats.pending, inFlight: lastOutboxStats.inFlight, total: lastOutboxStats.total } } : {}),
                lastEventAt,
                lastError
            }),
            subscribe: (fn: (e: any) => void) => {
                devtoolsSubscribers.add(fn)
                return () => {
                    devtoolsSubscribers.delete(fn)
                }
            }
        }
    } as const

    const extension: WithSyncExtension = { sync }

    const dispose = () => {
        try {
            engine?.dispose()
        } catch {
            // ignore
        }
        engine = null

        for (let i = unregister.length - 1; i >= 0; i--) {
            try {
                unregister[i]!()
            } catch {
                // ignore
            }
        }

        if (originalStoreFn) {
            try {
                client.Store = originalStoreFn
            } catch {
                // ignore
            }
        }
    }

    ctx.onDispose(dispose)

    return { extension, dispose }
}

function defaultDeviceId(): string {
    const cryptoAny = (globalThis as any)?.crypto
    const uuid = cryptoAny?.randomUUID?.bind(cryptoAny)
    if (typeof uuid === 'function') {
        try {
            return String(uuid())
        } catch {
            // ignore
        }
    }
    return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
}

function mapTranslatedWriteOpsToOutboxWrites(writeOps: PersistRequest<any>['writeOps']): OutboxWrite[] {
    const out: OutboxWrite[] = []
    for (const w of writeOps) {
        const op: any = w.op
        if (!op || op.kind !== 'write') {
            throw new Error('[atoma-sync] outbox: 仅支持 write op（TranslatedWriteOp.op.kind 必须为 \"write\"）')
        }

        const write: any = op.write
        const resource = String(write?.resource ?? '')
        const action = write?.action as WriteAction
        const options = (write?.options && typeof write.options === 'object') ? (write.options as WriteOptions) : undefined
        const items: WriteItem[] = Array.isArray(write?.items) ? (write.items as WriteItem[]) : []
        if (!resource || !action || items.length !== 1) {
            throw new Error('[atoma-sync] outbox: write op 必须包含 resource/action 且只能有 1 个 item')
        }

        const item = items[0] as any
        const meta = item?.meta
        if (!meta || typeof meta !== 'object') {
            throw new Error('[atoma-sync] outbox: write item meta 必填（需要 idempotencyKey/clientTimeMs）')
        }
        if (typeof meta.idempotencyKey !== 'string' || !meta.idempotencyKey) {
            throw new Error('[atoma-sync] outbox: write item meta.idempotencyKey 必填')
        }
        if (typeof meta.clientTimeMs !== 'number' || !Number.isFinite(meta.clientTimeMs)) {
            throw new Error('[atoma-sync] outbox: write item meta.clientTimeMs 必填')
        }

        out.push({
            resource,
            action: action as any,
            item: item as any,
            ...(options ? { options } : {})
        })
    }
    return out
}

function errorMessageFromStandardError(err: any, fallback: string): string {
    if (err && typeof err === 'object') {
        const msg = (err as any).message
        if (typeof msg === 'string' && msg) return msg
    }
    return fallback
}

class WritebackApplier implements SyncApplier {
    private opSeq = 0

    constructor(private readonly deps: {
        ctx: ClientPluginContext
        remoteOpsClient: { executeOps: (input: any) => Promise<any> }
        localOpsClient?: any
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
        now: () => number
    }) {}

    applyPullChanges = async (changes: Change[]) => {
        const list = Array.isArray(changes) ? changes : []
        if (!list.length) return

        const byResource = new Map<string, Change[]>()
        for (const change of list) {
            const existing = byResource.get(change.resource)
            if (existing) existing.push(change)
            else byResource.set(change.resource, [change])
        }

        for (const [resource, changesForResource] of byResource.entries()) {
            const deleteKeys: EntityId[] = []
            const upsertEntityIds: EntityId[] = []

            for (const c of changesForResource) {
                if (c.kind === 'delete') {
                    deleteKeys.push(String(c.entityId) as EntityId)
                    continue
                }
                upsertEntityIds.push(String(c.entityId) as EntityId)
            }

            const uniqueUpsertKeys = Array.from(new Set(upsertEntityIds))
            const uniqueDeleteKeys = Array.from(new Set(deleteKeys))

            const obs = this.deps.ctx.runtime.observability.createContext(resource)

            const upserts = uniqueUpsertKeys.length
                ? (await this.queryResource(this.deps.remoteOpsClient, { resource, params: { where: { id: { in: uniqueUpsertKeys } } } as any, context: obs })).items
                    .filter((i: any): i is any => i !== undefined)
                : []

            await this.deps.ctx.writeback.apply(resource, {
                upserts,
                deletes: uniqueDeleteKeys
            } as any)

            await this.persistToLocal(resource, { upserts, deletes: uniqueDeleteKeys })
        }
    }

    applyWriteAck = async (ack: SyncWriteAck) => {
        const key = (ack.item as any)?.meta && typeof (ack.item as any).meta === 'object'
            ? (ack.item as any).meta.idempotencyKey
            : undefined
        if (typeof key === 'string' && key) {
            this.deps.ctx.acks.ack(key)
        }

        const upserts: any[] = []
        const deletes: EntityId[] = []
        const versionUpdates: Array<{ key: EntityId; version: number }> = []

        const version = ack.result.version
        if (typeof version === 'number' && Number.isFinite(version)) {
            versionUpdates.push({ key: String(ack.result.entityId) as EntityId, version })
        }

        const serverData = ack.result.data
        if (serverData && typeof serverData === 'object') {
            upserts.push(serverData)
        }

        await this.deps.ctx.writeback.apply(ack.resource, { upserts, deletes, versionUpdates } as any)
        await this.persistToLocal(ack.resource, { upserts, deletes, versionUpdates })
    }

    applyWriteReject = async (
        reject: SyncWriteReject,
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    ) => {
        const key = (reject.item as any)?.meta && typeof (reject.item as any).meta === 'object'
            ? (reject.item as any).meta.idempotencyKey
            : undefined
        if (typeof key === 'string' && key) {
            this.deps.ctx.acks.reject(key, (reject.result as any)?.error ?? reject.result)
        }

        const upserts: any[] = []
        const deletes: EntityId[] = []

        if (reject.action === 'create') {
            const tempEntityId = (reject.item as any)?.entityId
            const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                ? (tempEntityId as EntityId)
                : null
            if (tempKey !== null) {
                deletes.push(tempKey)
            }
        }

        const strategy = conflictStrategy ?? this.deps.conflictStrategy ?? 'server-wins'
        const error = (reject.result as any)?.error
        const current = (reject.result as any)?.current
        if (error?.code === 'CONFLICT' && current?.value && strategy === 'server-wins') {
            upserts.push(current.value)
        }

        await this.deps.ctx.writeback.apply(reject.resource, { upserts, deletes } as any)
        await this.persistToLocal(reject.resource, { upserts, deletes })
    }

    applyWriteResults = async (args: {
        acks: SyncWriteAck[]
        rejects: SyncWriteReject[]
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
        signal?: AbortSignal
    }) => {
        const acks = Array.isArray(args.acks) ? args.acks : []
        const rejects = Array.isArray(args.rejects) ? args.rejects : []

        for (const ack of acks) {
            if (args.signal?.aborted) return
            await this.applyWriteAck(ack)
        }
        for (const reject of rejects) {
            if (args.signal?.aborted) return
            await this.applyWriteReject(reject, args.conflictStrategy)
        }
    }

    private nextOpId = (prefix: 'q' | 'w') => {
        this.opSeq += 1
        return `${prefix}_${this.deps.now()}_${this.opSeq}`
    }

    private toProtocolValidationError = (error: unknown, fallbackMessage: string): Error => {
        const standard = Protocol.error.wrap(error, {
            code: 'INVALID_RESPONSE',
            message: fallbackMessage,
            kind: 'validation'
        })
        const err = new Error(`[atoma-sync] ${standard.message}`)
        ;(err as any).error = standard
        return err
    }

    private executeOps = async (
        opsClient: { executeOps: (...args: any[]) => Promise<any> },
        ops: Operation[],
        context?: import('atoma/observability').ObservabilityContext
    ): Promise<OperationResult[]> => {
        const traceId = (typeof (context as any)?.traceId === 'string' && (context as any).traceId) ? (context as any).traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops,
            traceId,
            ...(context ? { nextRequestId: (context as any).requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now: this.deps.now,
            traceId,
            requestId: context ? (context as any).requestId() : undefined
        })
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })
        const res = await opsClient.executeOps({ ops: opsWithTrace, meta, context })
        try {
            return Protocol.ops.validate.assertOperationResults((res as any).results)
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid ops response')
        }
    }

    private queryResource = async (
        opsClient: { executeOps: (...args: any[]) => Promise<any> },
        args2: { resource: string; params: QueryParams; context?: any }
    ): Promise<{ items: any[]; pageInfo?: any }> => {
        const op: Operation = Protocol.ops.build.buildQueryOp({
            opId: this.nextOpId('q'),
            resource: args2.resource,
            params: args2.params
        })
        const results = await this.executeOps(opsClient, [op], args2.context)
        const result = results[0]
        if (!result) throw new Error('[atoma-sync] Missing query result')
        let parsedResult: OperationResult
        try {
            parsedResult = Protocol.ops.validate.assertOperationResult(result)
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid query result')
        }
        if (parsedResult.ok !== true) {
            const errObj = parsedResult.error
            const err = new Error(errorMessageFromStandardError(errObj, 'Query failed'))
            ;(err as any).error = errObj
            throw err
        }

        let data: QueryResultData
        try {
            data = Protocol.ops.validate.assertQueryResultData(parsedResult.data) as QueryResultData
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid query result data')
        }
        return {
            items: (data as any).items as any[],
            pageInfo: (data as any)?.pageInfo
        }
    }

    private writeResource = async (
        opsClient: { executeOps: (...args: any[]) => Promise<any> },
        args2: { resource: string; action: WriteAction; items: WriteItem[]; options?: WriteOptions; context?: any }
    ): Promise<WriteResultData> => {
        const op: Operation = Protocol.ops.build.buildWriteOp({
            opId: this.nextOpId('w'),
            write: {
                resource: args2.resource,
                action: args2.action,
                items: args2.items,
                ...(args2.options ? { options: args2.options } : {})
            }
        })
        const results = await this.executeOps(opsClient, [op], args2.context)
        const result = results[0]
        if (!result) throw new Error('[atoma-sync] Missing write result')
        let parsedResult: OperationResult
        try {
            parsedResult = Protocol.ops.validate.assertOperationResult(result)
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid write result')
        }
        if (parsedResult.ok !== true) {
            const errObj = parsedResult.error
            const err = new Error(errorMessageFromStandardError(errObj, 'Write failed'))
            ;(err as any).error = errObj
            throw err
        }

        let data: WriteResultData
        try {
            data = Protocol.ops.validate.assertWriteResultData(parsedResult.data) as WriteResultData
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid write result data')
        }

        const itemResults = Array.isArray((data as any)?.results) ? ((data as any).results as any[]) : []
        for (const r of itemResults) {
            if (r.ok === true) continue
            const msg = errorMessageFromStandardError((r as any).error, 'Write failed')
            const err = new Error(msg)
            ;(err as any).error = (r as any).error
            ;(err as any).current = (r as any).current
            throw err
        }

        return data
    }

    private newWriteItemMeta = (): WriteItemMeta => {
        return Protocol.ops.meta.newWriteItemMeta({ now: this.deps.now })
    }

    private desiredBaseVersionFromTargetVersion = (version: unknown): number | undefined => {
        if (typeof version !== 'number' || !Number.isFinite(version) || version <= 1) return undefined
        return Math.floor(version) - 1
    }

    private persistToLocal = async (
        resource: string,
        args2: { upserts?: any[]; deletes?: EntityId[]; versionUpdates?: Array<{ key: EntityId; version: number }> }
    ) => {
        const localOpsClient = this.deps.localOpsClient
        if (!localOpsClient) return

        const upserts = Array.isArray(args2.upserts) ? args2.upserts : []
        const deletes = Array.isArray(args2.deletes) ? args2.deletes : []
        const versionUpdates = Array.isArray(args2.versionUpdates) ? args2.versionUpdates : []

        if (upserts.length) {
            const items: WriteItem[] = []
            for (const u of upserts) {
                const id = (u as any)?.id
                if (typeof id !== 'string' || !id) continue
                const baseVersion = this.desiredBaseVersionFromTargetVersion((u as any)?.version)
                items.push({
                    entityId: id,
                    ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                    value: u,
                    meta: this.newWriteItemMeta()
                } as any)
            }
            if (items.length) {
                await this.writeResource(localOpsClient, {
                    resource,
                    action: 'upsert',
                    items,
                    options: { merge: false, upsert: { mode: 'loose' } }
                })
            }
        }
        if (deletes.length) {
            const { items: currentItems } = await this.queryResource(localOpsClient, {
                resource,
                params: { where: { id: { in: deletes } } } as any
            })
            const currentById = new Map<EntityId, any>()
            for (const row of currentItems) {
                const id = (row as any)?.id
                if (typeof id === 'string' && id) currentById.set(id, row)
            }
            const deleteItems: Array<{ id: EntityId; baseVersion: number }> = []
            for (let i = 0; i < deletes.length; i++) {
                const id = deletes[i]
                const row = currentById.get(id)
                if (!row || typeof row !== 'object') continue
                const baseVersion = (row as any).version
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                    throw new Error(`[atoma-sync] local delete requires baseVersion (missing version for id=${String(id)})`)
                }
                deleteItems.push({ id, baseVersion })
            }
            if (deleteItems.length) {
                const items: WriteItem[] = deleteItems.map(d => ({
                    entityId: d.id,
                    baseVersion: d.baseVersion,
                    meta: this.newWriteItemMeta()
                } as any))
                await this.writeResource(localOpsClient, { resource, action: 'delete', items })
            }
        }
        if (versionUpdates.length) {
            const versionByKey = new Map<EntityId, number>()
            versionUpdates.forEach(v => versionByKey.set(v.key, v.version))

            const upsertedKeys = new Set<EntityId>()
            upserts.forEach(u => {
                const id = (u as any)?.id
                if (typeof id === 'string' && id) upsertedKeys.add(id)
            })

            const toUpdate = Array.from(versionByKey.entries())
                .filter(([key]) => !upsertedKeys.has(key))
                .map(([key]) => key)

            if (toUpdate.length) {
                const { items: currentItems } = await this.queryResource(localOpsClient, {
                    resource,
                    params: { where: { id: { in: toUpdate } } } as any
                })

                const items: WriteItem[] = []
                for (const row of currentItems) {
                    const id = (row as any)?.id
                    if (typeof id !== 'string' || !id) continue
                    const nextVersion = versionByKey.get(id)
                    if (nextVersion === undefined) continue

                    const baseVersion = this.desiredBaseVersionFromTargetVersion(nextVersion)
                    items.push({
                        entityId: id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: { ...(row as any), version: nextVersion },
                        meta: this.newWriteItemMeta()
                    } as any)
                }

                if (items.length) {
                    await this.writeResource(localOpsClient, {
                        resource,
                        action: 'upsert',
                        items,
                        options: { merge: true, upsert: { mode: 'loose' } }
                    })
                }
            }
        }
    }
}
