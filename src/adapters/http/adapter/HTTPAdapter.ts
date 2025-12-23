import type { IAdapter, StoreKey, Entity, StoreAccess } from '../../../core/types'
import { makeUrl } from '../request'
import { BatchEngine, Batch } from '#batch'
import type { ObservabilityContext } from '#observability'
import { fetchWithRetry } from '../transport/retry'
import type { BatchQueryConfig, HTTPAdapterConfig } from '../config/types'
import { createOpsTransport } from '../transport/ops'
import { Sync, type SyncClient } from '../../../sync'
import { OperationRouter } from './OperationRouter'
import { StateWriter } from '../state/StateWriter'
import { transformToInstructions } from '../state/transformToInstructions'
import type { StateWriteInstruction } from '../state/types'

const ROUTER_METHODS = [
    'put',
    'bulkPut',
    'bulkCreate',
    'delete',
    'bulkDelete',
    'get',
    'bulkGet',
    'getAll',
    'findMany',
    'applyPatches'
] as const


type ParsedBatchConfig = {
    enabled: boolean
    endpoint?: string
    maxBatchSize?: number
    flushIntervalMs?: number
    devWarnings: boolean
}

/**
 * HTTP Adapter for ops-based APIs
 */
export class HTTPAdapter<T extends Entity> {
    public readonly name: string
    private readonly queueStorageKey: string
    private batchEngine?: BatchEngine
    private router: OperationRouter<T>
    private stateWriter: StateWriter<T>
    private resourceNameForBatch: string
    private usePatchForUpdate: boolean
    private storeAccess?: StoreAccess<T>
    private syncEngine?: SyncClient
    private opsTransport: ReturnType<typeof createOpsTransport>

    constructor(private config: HTTPAdapterConfig<T>) {
        if (!config.resourceName) {
            throw new Error('[HTTPAdapter] "resourceName" is required for ops routing')
        }

        const batchConfig = this.parseBatchConfig(config.batch)
        this.resourceNameForBatch = this.normalizeResourceName(config.resourceName)
        this.usePatchForUpdate = config.usePatchForUpdate ?? false

        this.name = config.baseURL
        this.queueStorageKey = `atoma:httpQueue:${this.name}`
        this.stateWriter = new StateWriter<T>({
            getStoreAccess: () => this.storeAccess
        })

        this.opsTransport = createOpsTransport({
            fetchFn: this.fetchWithRetry.bind(this),
            getHeaders: this.getHeaders.bind(this),
            interceptors: {
                onRequest: this.config.onRequest,
                onResponse: this.config.onResponse as any
            }
        })

        const opsExecute = async (ops: any[], context?: ObservabilityContext) => {
            return this.executeOps(ops, context)
        }

        if (batchConfig.enabled) {
            const endpointPath = batchConfig.endpoint ?? '/ops'
            const batchEndpoint = makeUrl(this.config.baseURL, endpointPath)
            this.batchEngine = Batch.create({
                endpoint: batchEndpoint,
                maxBatchSize: batchConfig.maxBatchSize,
                flushIntervalMs: batchConfig.flushIntervalMs,
                headers: this.getHeaders.bind(this),
                fetchFn: this.fetchWithRetry.bind(this),
                onError: (error, payload) => {
                    this.onError(error, 'batch')
                    if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                        console.debug?.('[HTTPAdapter:batch] payload failed', payload)
                    }
                }
            })

            if (batchConfig.devWarnings && typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                console.info(
                    `[Atoma] BatchQuery enabled for "${this.resourceNameForBatch}" → ${batchEndpoint}\n` +
                    'Ensure backend exposes the ops endpoint. Set `batch:false` to disable.'
                )
            }
        }

        const syncEnabled = this.config.sync?.enabled === true
        if (syncEnabled) {
            const outboxKey = `${this.queueStorageKey}:sync-vnext`
            const cursorKey = this.config.sync?.cursorKey ?? `atoma:sync:${this.config.baseURL}:vnext:cursor`
            const baseURL = this.config.baseURL
            const opsEndpoint = this.config.sync?.endpoints?.ops ?? '/ops'
            const subscribeEndpoint = this.config.sync?.endpoints?.subscribeVNext ?? '/sync/subscribe-vnext'

            this.syncEngine = Sync.create({
                executeOps: async (args) => {
                    return this.executeOps(args.ops, undefined, {
                        v: args.meta?.v,
                        deviceId: args.meta?.deviceId,
                        clientTimeMs: args.meta?.clientTimeMs
                    }, { baseURL, opsEndpoint })
                },
                subscribeUrl: (cursor) => {
                    const url = makeUrl(baseURL, subscribeEndpoint)
                    return `${url}?cursor=${encodeURIComponent(cursor)}`
                },
                eventSourceFactory: this.config.sync?.sse?.eventSourceFactory,
                onPullChanges: async (changes) => {
                    if (!this.storeAccess) return

                    const upsertIds = new Set<StoreKey>()
                    const deleteIds = new Set<StoreKey>()

                    const normalizeStoreKey = (id: StoreKey): StoreKey => {
                        if (typeof id === 'string' && /^[0-9]+$/.test(id)) {
                            return Number(id)
                        }
                        return id
                    }

                    for (const change of changes) {
                        const key = normalizeStoreKey(change.entityId as any)
                        if (change.kind === 'delete') {
                            deleteIds.add(key)
                        } else {
                            upsertIds.add(key)
                        }
                    }

                    const instructions: StateWriteInstruction<T>[] = []

                    if (upsertIds.size) {
                        const fetched = await this.router.bulkGet(Array.from(upsertIds))
                        const upserts = fetched.filter((i): i is T => i !== undefined)
                        if (upserts.length) {
                            instructions.push({ kind: 'upsert', items: upserts })
                        }
                    }

                    if (deleteIds.size) {
                        instructions.push({ kind: 'delete', keys: Array.from(deleteIds) })
                    }

                    if (!instructions.length) return
                    await this.stateWriter.applyInstructions(instructions)
                },
                onWriteAck: async (ack) => {
                    const instructions = transformToInstructions<T>({ source: 'syncAck', ack } as any, {
                        conflictStrategy: this.config.sync?.conflictStrategy
                    })
                    if (!instructions.length) return
                    await this.stateWriter.applyInstructions(instructions)
                },
                onWriteReject: async (reject, conflictStrategy) => {
                    const instructions = transformToInstructions<T>({
                        source: 'syncReject',
                        reject,
                        conflictStrategy
                    } as any, { conflictStrategy: this.config.sync?.conflictStrategy })
                    if (!instructions.length) return
                    await this.stateWriter.applyInstructions(instructions)
                },
                outboxKey,
                cursorKey,
                maxQueueSize: this.config.sync?.maxQueueSize ?? 1000,
                outboxEvents: {
                    onQueueChange: this.config.events?.onQueueChange,
                    onQueueFull: (dropped, max) => this.config.events?.onQueueFull?.(dropped as any, max)
                },
                maxPushItems: 50,
                pullLimit: this.config.sync?.pullLimit ?? 200,
                resources: [this.resourceNameForBatch],
                returning: true,
                conflictStrategy: this.config.sync?.conflictStrategy,
                subscribe: true,
                reconnectDelayMs: this.config.sync?.reconnectDelayMs ?? 1000,
                periodicPullIntervalMs: this.config.sync?.periodicPullIntervalMs ?? this.config.sync?.pollIntervalMs ?? 5_000,
                inFlightTimeoutMs: this.config.sync?.inFlightTimeoutMs ?? 30_000,
                retry: this.config.sync?.retry,
                backoff: this.config.sync?.backoff,
                lockKey: this.config.sync?.lockKey,
                lockTtlMs: this.config.sync?.lockTtlMs,
                lockRenewIntervalMs: this.config.sync?.lockRenewIntervalMs,
                onError: (error, context) => this.config.events?.onSyncError?.(error, context as any)
            })
        }

        this.router = new OperationRouter<T>({
            resource: this.resourceNameForBatch,
            batch: this.batchEngine,
            sync: this.syncEngine,
            opsExecute,
            usePatchForUpdate: this.usePatchForUpdate,
            resolveBaseVersion: this.resolveLocalBaseVersion.bind(this),
            onError: this.onError.bind(this),
            now: () => Date.now(),
            queryCustomFn: this.config.query?.customFn
        })
        this.bindRouterMethods()
    }

    dispose(): void {
        this.detachStoreAccess()
        this.batchEngine?.dispose()
        this.syncEngine?.dispose()
    }

    attachStoreAccess(access: StoreAccess<T>) {
        this.storeAccess = access
        if (this.config.sync?.enabled === true && this.config.sync?.autoStart !== false) {
            void this.startSync()
        }
    }

    detachStoreAccess() {
        this.stopSync()
        this.storeAccess = undefined
    }

    private async startSync() {
        if (!this.config.sync?.enabled) return
        if (!this.syncEngine) return
        this.syncEngine.start()
    }

    private stopSync() {
        if (!this.syncEngine) return
        this.syncEngine.stop()
    }

    private async executeOps(
        ops: any[],
        context?: ObservabilityContext,
        meta?: { v?: number; deviceId?: string; clientTimeMs?: number },
        override?: { baseURL?: string; opsEndpoint?: string }
    ) {
        const result = await this.opsTransport.executeOps({
            url: override?.baseURL ?? this.config.baseURL,
            endpoint: override?.opsEndpoint ?? (this.config.sync?.endpoints?.ops ?? '/ops'),
            ops,
            context,
            v: meta?.v,
            deviceId: meta?.deviceId,
            clientTimeMs: meta?.clientTimeMs
        })
        return result.results as any
    }

    private resolveLocalBaseVersion(id: StoreKey, value?: any): number {
        const versionFromValue = value && typeof value === 'object' ? (value as any).version : undefined
        if (typeof versionFromValue === 'number' && Number.isFinite(versionFromValue)) return versionFromValue
        const fromStore = this.storeAccess?.jotaiStore.get(this.storeAccess.atom).get(id) as any
        const v = fromStore?.version
        if (typeof v === 'number' && Number.isFinite(v)) return v
        return 0
    }



    async onConnect(): Promise<void> {
        // HTTP connects on-demand, nothing to do
    }

    onDisconnect(): void {
        // HTTP disconnects automatically
    }

    onError(error: Error, operation: string): void {
        console.error(`[HTTPAdapter:${this.name}] Error in ${operation}:`, error)
    }

    /**
     * Fetch with retry logic
     */
    private async fetchWithRetry(
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> {
        return fetchWithRetry(fetch, input, init, this.config.retry)
    }

    /**
     * Get headers (supports async for auth tokens)
     */
    private async getHeaders(): Promise<Record<string, string>> {
        if (!this.config.headers) {
            return {}
        }

        const headers = this.config.headers()
        return headers instanceof Promise ? await headers : headers
    }

    private bindRouterMethods() {
        const router = this.router
        ROUTER_METHODS.forEach(method => {
            ;(this as any)[method] = (router as any)[method].bind(router)
        })
    }

    private parseBatchConfig(batch?: boolean | BatchQueryConfig): ParsedBatchConfig {
        if (batch === true) {
            return { enabled: true, devWarnings: true }
        }
        if (batch === false) {
            return { enabled: false, devWarnings: true }
        }
        const cfg = batch || {}
        return {
            enabled: cfg.enabled !== false,
            endpoint: cfg.endpoint,
            maxBatchSize: cfg.maxBatchSize,
            flushIntervalMs: cfg.flushIntervalMs,
            devWarnings: cfg.devWarnings !== false
        }
    }

    private normalizeResourceName(name?: string): string {
        if (!name) return 'unknown'
        const normalized = name.replace(/^\//, '')
        const parts = normalized.split('/')
        return parts[parts.length - 1] || 'unknown'
    }
}

export interface HTTPAdapter<T extends Entity> extends IAdapter<T> {}
