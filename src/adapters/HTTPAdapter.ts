import { Patch } from 'immer'
import { FindManyOptions, IAdapter, PatchMetadata, StoreKey, PageInfo, Entity } from '../core/types'
import type { DevtoolsBridge } from '../devtools/types'
import { getGlobalDevtools } from '../devtools/global'
import { calculateBackoff } from './http/retry'
import { applyPatches } from 'immer'
import { resolveConflict } from './http/conflict'
import { makeUrl, RequestSender, resolveEndpoint } from './http/request'
import { ETagManager } from './http/etagManager'
import { BulkOperationHandler } from './http/bulkOperations'
import { HTTPEventEmitter } from './http/eventEmitter'
import { HTTPClient, ConflictHandler, ClientConfig } from './http/client'
import { SyncOrchestrator } from './http/syncOrchestrator'
import { createOperationExecutors, OperationExecutors } from './http/operationExecutors'
import type { QueuedOperation } from './http/offlineQueue'
import type { QuerySerializerConfig } from './http/query'
import { BatchEngine } from '../batch'
import { createRequestIdSequencer } from '../observability/trace'
import type { ObservabilityContext } from '../observability/types'
import type { StoreAccess } from '../core/types'
import { commitAtomMapUpdate } from '../core/store/cacheWriter'
import { validateWithSchema } from '../core/store/validation'
import type { StoreIndexes } from '../core/indexes/StoreIndexes'
import { getSyncHub, SyncHub } from './http/syncHub'
import type { AtomaChange } from '../protocol/sync'
import type { SyncQueuedOperation } from './http/syncOfflineQueue'
import { TRACE_ID_HEADER, REQUEST_ID_HEADER } from '../protocol/trace'

// ===== Config Interfaces =====

export interface RetryConfig {
    maxAttempts?: number
    backoff?: 'exponential' | 'linear'
    initialDelay?: number
    maxElapsedMs?: number
    jitter?: boolean
}

export interface ConflictConfig<T> {
    resolution?: 'last-write-wins' | 'server-wins' | 'manual'
    onConflict?: (args: {
        key: StoreKey
        local: T | Patch[]
        server: any
        metadata?: PatchMetadata
    }) => Promise<'accept-server' | 'retry-local' | 'ignore'> | 'accept-server' | 'retry-local' | 'ignore'
}

export interface VersionConfig {
    field?: string
    header?: string
    cacheSize?: number
}

export interface OfflineConfig {
    enabled?: boolean
    maxQueueSize?: number
    syncOnReconnect?: boolean
}

export interface SyncEndpointsConfig {
    push?: string
    pull?: string
    subscribe?: string
}

export interface SyncSseConfig {
    /**
     * 自定义订阅 URL（用于 token query 等）
     * - url: 不含 cursor 的 subscribe 完整 URL（已做 baseURL 拼接）
     * - cursor: 当前游标
     * - headers: 同步模式下的 auth headers（可复用其中的 token）
     */
    buildSubscribeUrl?: (args: { url: string; cursor: number; headers: Record<string, string> }) => string | Promise<string>

    /**
     * 自定义 EventSource 构造（用于 polyfill 注入 headers / withCredentials 等）
     */
    eventSourceFactory?: (args: { url: string; headers: Record<string, string> }) => EventSource
}

export interface SyncConfig {
    /**
     * 启用 sync/offline（基于 /sync/push|pull|subscribe）
     * - 开启后写操作优先走 /sync/push（在线立即 push；离线入队，重连后重放）
     * - 变更流不带 payload：收到 changes 后会二次通过 bulkGet/batch 拉最终态写回 store
     */
    enabled?: boolean

    /**
     * 订阅模式
     * - 'sse'：使用 EventSource 连接 /sync/subscribe（浏览器优先）
     * - 'poll'：定时 GET /sync/pull（Node/SSR 或无 EventSource 时）
     */
    mode?: 'sse' | 'poll'

    endpoints?: SyncEndpointsConfig

    /** poll 模式间隔（默认 2000ms） */
    pollIntervalMs?: number

    /** pull 每次最大条数（默认 200） */
    pullLimit?: number

    /** 持久化游标 key（默认根据 baseURL 生成） */
    cursorKey?: string

    /** 持久化 deviceId key（默认根据 baseURL 生成） */
    deviceIdKey?: string

    /** attachStoreAccess 后自动启动（默认 true） */
    autoStart?: boolean

    /** SSE 行为扩展（鉴权/自定义 EventSource） */
    sse?: SyncSseConfig
}

export interface QueryConfig<T> {
    strategy?: 'REST' | 'Django' | 'GraphQL' | 'passthrough'
    serializer?: (options: FindManyOptions<T>) => URLSearchParams | object
    customFn?: (options: FindManyOptions<T>) => Promise<{ data: T[]; pageInfo?: PageInfo }>
}

export interface ConcurrencyConfig {
    get?: number
    put?: number
    delete?: number
    bulk?: number
}

export interface BulkConfig {
    fallback?: 'parallel' | 'sequential' | 'error'
    batchSize?: number
}

export interface EventCallbacks {
    onSyncStart?: (pending: number) => void
    onSyncComplete?: (remaining: number) => void
    onSyncError?: (error: Error, op: QueuedOperation) => void
    onQueueChange?: (size: number) => void
    onConflictResolved?: (serverValue: any, key: StoreKey) => void
    onQueueFull?: (droppedOp: QueuedOperation, maxSize: number) => void
}

/**
 * HTTP adapter configuration
 */
export interface HTTPAdapterConfig<T> {
    /** Base URL for API */
    baseURL: string

    /** Resource name for auto-generating RESTful endpoints (e.g., 'todos' or '/api/v1/todos') */
    resourceName?: string

    /** Endpoint templates - supports string, template (/api/:id), or function */
    /** If not provided, will be auto-generated from resourceName */
    endpoints?: {
        // Single-item operations
        getOne?: string | ((id: StoreKey) => string)
        getAll?: string | (() => string)
        create?: string | (() => string)
        update?: string | ((id: StoreKey) => string)
        delete?: string | ((id: StoreKey) => string)
        patch?: string | ((id: StoreKey) => string)

        // Bulk operations (optional)
        bulkCreate?: string | (() => string)
        bulkUpdate?: string | (() => string)
        bulkDelete?: string | (() => string)
        bulkDeleteQueryParam?: {
            path: string | (() => string)
            param: string
            maxUrlLength?: number
        }
    }

    /** Headers function (can be async for auth tokens) */
    headers?: () => Promise<Record<string, string>> | Record<string, string>

    /** Retry configuration */
    retry?: RetryConfig

    /** Conflict resolution */
    conflict?: ConflictConfig<T>

    /** Version/ETag support */
    version?: VersionConfig

    /** Offline queue */
    offline?: OfflineConfig

    /** Sync + offline（/sync/*） */
    sync?: SyncConfig

    /** Query/findMany configuration */
    query?: QueryConfig<T>

    /** Query param serialization */
    querySerializer?: QuerySerializerConfig

    /** Concurrency limits */
    concurrency?: ConcurrencyConfig

    /** Bulk operation behavior */
    bulk?: BulkConfig

    /** Event callbacks */
    events?: EventCallbacks

    /** Devtools bridge（可选） */
    devtools?: DevtoolsBridge

    /**
     * 批量查询（Batch Query）开关
     * - true: 启用批量，默认 /batch 端点
     * - object: 自定义端点/批量大小/flush 延迟
     * - undefined/false: 关闭（默认）
     */
    batch?: boolean | BatchQueryConfig

    /** 
     * Response Parser (Anti-Corruption Layer) 
     * Pure function to map arbitrary backend response to Atoma Standard Envelope
     */
    responseParser?: ResponseParser<T>

    /**
     * 更新时（含批量）优先使用 patches（patch/bulkPatch），否则走全量 update/bulkUpdate
     */
    usePatchForUpdate?: boolean

    /**
     * Global request interceptor.
     * Return a new Request to modify, or void to continue with original.
     * Throw error to cancel request.
     */
    onRequest?: (request: Request) => Promise<Request | void> | Request | void

    /**
     * Global response interceptor (Side Effects)
     * Replaces onMeta. logical place for logging, toasts, redirects.
     */
    onResponse?: (context: {
        response: Response
        envelope: StandardEnvelope<T>
        request: Request
    }) => void
}

/**
 * Standard Envelope for Atoma internals
 * All responses are normalized to this structure
 */
export interface StandardEnvelope<T> {
    /** The actual data payload (single item or array) */
    data: T | T[]

    /** Optional pagination info */
    pageInfo?: {
        total?: number
        hasNext?: boolean
        nextCursor?: string
        prevCursor?: string
        [key: string]: any
    }

    /** User-facing message (e.g. for toasts) */
    message?: string

    /** Error code or status code */
    code?: string | number

    /** Whether this response should be treated as an error */
    isError?: boolean

    /** Any other metadata to pass to onMeta */
    meta?: any
}

/**
 * Pure function to map backend response to StandardEnvelope
 */
export type ResponseParser<T, Raw = any> = (response: Response, data: Raw) => Promise<StandardEnvelope<T>> | StandardEnvelope<T>

export interface BatchQueryConfig {
    enabled?: boolean
    endpoint?: string
    maxBatchSize?: number
    flushIntervalMs?: number
    devWarnings?: boolean
}

type ParsedBatchConfig = {
    enabled: boolean
    endpoint?: string
    maxBatchSize?: number
    flushIntervalMs?: number
    devWarnings: boolean
}

/**
 * Queued operation for offline support
 */
/**
 * HTTP Adapter for RESTful APIs
 */
export class HTTPAdapter<T extends Entity> implements IAdapter<T> {
    public readonly name: string
    private readonly queueStorageKey: string
    private readonly maxRetryElapsedMs: number
    private etagManager: ETagManager
    private bulkOps: BulkOperationHandler<T>
    private eventEmitter: HTTPEventEmitter
    private client: HTTPClient<T>
    private orchestrator: SyncOrchestrator<T>
    private executors: OperationExecutors<T>
    private serializerConfig?: QuerySerializerConfig
    private batchEngine?: BatchEngine
    private resourceNameForBatch: string
    private usePatchForUpdate: boolean
    private readonly requestIdSequencer = createRequestIdSequencer()
    private storeAccess?: StoreAccess<T>
    private syncHub?: SyncHub
    private syncHandler?: (changes: AtomaChange[]) => void
    private pendingChangeFlush: ReturnType<typeof setTimeout> | undefined
    private bufferedChanges: AtomaChange[] = []

    constructor(private config: HTTPAdapterConfig<T>) {
        // Auto-generate endpoints from resourceName if not explicitly provided
        if (!config.endpoints) {
            if (!config.resourceName) {
                throw new Error(
                    '[HTTPAdapter] Either "resourceName" or "endpoints" must be provided.\n' +
                    'Use "resourceName" for auto-generated RESTful endpoints, or provide custom "endpoints".'
                )
            }

            // Normalize path: ensure it starts with /
            const basePath = config.resourceName.startsWith('/')
                ? config.resourceName
                : `/${config.resourceName}`

            // Auto-generate RESTful endpoints
            config.endpoints = {
                getOne: (id) => `${basePath}/${id}`,
                getAll: () => basePath,
                create: () => basePath,
                update: (id) => `${basePath}/${id}`,
                delete: (id) => `${basePath}/${id}`,
                patch: (id) => `${basePath}/${id}`,
                bulkCreate: () => `${basePath}/bulk`,
                bulkUpdate: () => `${basePath}/bulk`,
                bulkDelete: () => `${basePath}/bulk`,
                bulkDeleteQueryParam: {
                    path: () => basePath,
                    param: 'ids',
                    maxUrlLength: 1800
                }
            }
        }

        // At this point, endpoints is guaranteed to be defined
        const endpoints = config.endpoints!
        const batchConfig = this.parseBatchConfig(config.batch)
        this.resourceNameForBatch = this.normalizeResourceName(config.resourceName)
        this.usePatchForUpdate = config.usePatchForUpdate ?? false

        this.name = config.baseURL
        this.queueStorageKey = `atoma:httpQueue:${this.name}`
        this.etagManager = new ETagManager(config.version?.cacheSize ?? 1000)
        this.bulkOps = new BulkOperationHandler<T>(
            {
                bulkCreate: endpoints.bulkCreate,
                bulkUpdate: endpoints.bulkUpdate,
                bulkDelete: endpoints.bulkDelete,
                bulkDeleteQueryParam: endpoints.bulkDeleteQueryParam,
                fallback: config.bulk?.fallback ?? 'parallel',
                concurrency: config.concurrency?.bulk ?? 5,
                batchSize: config.bulk?.batchSize ?? Infinity
            },
            {
                put: (item, internalContext) => this.put(item.id, item, internalContext),
                delete: (key, internalContext) => this.delete(key, internalContext)
            }
        )
        const conflictHandler: ConflictHandler<T> = {
            handle: async (response, key, localValue, conflictBody, metadata) => {
                let serverData: any
                try {
                    serverData = conflictBody || await response.json()
                } catch {
                    // No body? try re-fetching
                    const getResponse = await this.fetchWithRetry(
                        makeUrl(this.config.baseURL, resolveEndpoint(endpoints.getOne!, key)),
                        { headers: await this.getHeaders() }
                    )
                    if (getResponse.ok) {
                        serverData = await getResponse.json()
                    }
                }
                const etag = this.etagManager.extractFromResponse(response)

                await resolveConflict<T>(
                    response,
                    key,
                    localValue,
                    {
                        resolution: this.config.conflict?.resolution ?? 'last-write-wins',
                        onConflict: this.config.conflict?.onConflict,
                        onResolved: config.events?.onConflictResolved,
                        version: this.config.version,
                        onEtagExtracted: (k, tag) => this.etagManager.set(k, tag)
                    },
                    (k, v) => this.client.put(k, v),
                    metadata,
                    serverData,
                    etag
                )
            }
        }

        this.client = new HTTPClient(
            this.config as ClientConfig,
            this.sender,
            this.etagManager,
            () => this.getHeaders(),
            conflictHandler
        )

        this.eventEmitter = new HTTPEventEmitter(config.events)
        this.maxRetryElapsedMs = config.retry?.maxElapsedMs ?? 30000
        this.serializerConfig = config.querySerializer
        this.orchestrator = new SyncOrchestrator(config, {
            queueStorageKey: this.queueStorageKey,
            eventEmitter: this.eventEmitter,
            client: this.client,
            fetchWithRetry: this.fetchWithRetry.bind(this),
            getHeaders: this.getHeaders.bind(this),
            requestIdSequencer: this.requestIdSequencer,
            retry: config.retry,
            devtools: config.devtools ?? getGlobalDevtools(),
            onSyncPushResult: async (res, ops) => {
                await this.handleSyncRejected(res.rejected as any, ops as any, undefined)
                await this.applyAckedVersions(res.acked.map(a => ({
                    id: (typeof a.id === 'string' && /^[0-9]+$/.test(a.id)) ? Number(a.id) : a.id as any,
                    serverVersion: a.serverVersion
                })))
            }
        })

        this.executors = createOperationExecutors({
            config: this.config,
            client: this.client,
            bulkOps: this.bulkOps,
            etagManager: this.etagManager,
            fetchWithRetry: this.fetchWithRetry.bind(this),
            getHeaders: this.getHeaders.bind(this),
            requestIdSequencer: this.requestIdSequencer,
            orchestrator: this.orchestrator,
            onError: this.onError.bind(this)
        })

        if (batchConfig.enabled) {
            const endpointPath = batchConfig.endpoint ?? '/batch'
            const batchEndpoint = makeUrl(this.config.baseURL, endpointPath)
            this.batchEngine = new BatchEngine({
                endpoint: batchEndpoint,
                maxBatchSize: batchConfig.maxBatchSize,
                flushIntervalMs: batchConfig.flushIntervalMs,
                headers: this.getHeaders.bind(this),
                fetchFn: this.fetchWithRetry.bind(this),
                requestIdSequencer: this.requestIdSequencer,
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
                    'Ensure backend exposes the batch endpoint. Set `batch:false` to disable.'
                )
            }
        }
    }

    dispose(): void {
        this.detachStoreAccess()
        this.orchestrator.dispose()
        // Clear ETag cache to free memory
        this.etagManager.clear()
        this.batchEngine?.dispose()
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

    async put(key: StoreKey, value: T, internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.sync?.enabled === true) {
            const op = this.buildSyncPutOp(key, value)
            const res = await this.orchestrator.pushOrQueueSyncOps([op], { traceId: internalContext?.traceId })
            if (!res) return
            await this.handleSyncRejected(res.rejected, [op], internalContext)
            await this.applyAckedVersions(res.acked.map(a => ({
                id: (typeof a.id === 'string' && /^[0-9]+$/.test(a.id)) ? Number(a.id) : a.id as any,
                serverVersion: a.serverVersion
            })))
            return
        }
        if (this.batchEngine) {
            try {
                const baseVersion = this.resolveLocalBaseVersion(key, value)
                return await this.batchEngine.enqueuePatch(
                    this.resourceNameForBatch,
                    {
                        id: key,
                        patches: [{ op: 'replace', path: [key], value }] as any,
                        baseVersion,
                        timestamp: Date.now()
                    },
                    internalContext
                )
            } catch (error) {
                this.onError(error as Error, 'put(batch)')
                throw error
            }
        }
        const baseVersion = this.resolveLocalBaseVersion(key, value)
        const traceId = internalContext?.traceId
        const trace = (typeof traceId === 'string' && traceId)
            ? { traceId, requestId: this.requestIdSequencer.next(traceId) }
            : undefined
        const ctx = trace && internalContext ? internalContext.with({ requestId: trace.requestId }) : internalContext
        const payload = (value && typeof value === 'object')
            ? ({ ...(value as any), baseVersion } as any)
            : value
        await this.orchestrator.handleWithOfflineFallback(
            { type: 'put', key, value: payload },
            () => this.client.put(
                key,
                payload,
                trace ? { [TRACE_ID_HEADER]: trace.traceId, [REQUEST_ID_HEADER]: trace.requestId } : undefined,
                ctx
            )
        )
    }

    async bulkPut(items: T[], internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.sync?.enabled === true) {
            const ops = items.map(item => this.buildSyncPutOp((item as any).id, item))
            const res = await this.orchestrator.pushOrQueueSyncOps(ops, { traceId: internalContext?.traceId })
            if (!res) return
            await this.handleSyncRejected(res.rejected, ops, internalContext)
            await this.applyAckedVersions(res.acked.map(a => ({
                id: (typeof a.id === 'string' && /^[0-9]+$/.test(a.id)) ? Number(a.id) : a.id as any,
                serverVersion: a.serverVersion
            })))
            return
        }
        if (!items.length) return
        await Promise.all(items.map(item => this.put((item as any).id, item, internalContext)))
    }

    async bulkCreate(items: T[], internalContext?: ObservabilityContext): Promise<T[] | void> {
        if (this.batchEngine) {
            const created = await Promise.all(items.map(item => {
                return this.batchEngine!.enqueueCreate(
                    this.resourceNameForBatch,
                    item,
                    internalContext
                )
            }))
            return created
        }

        if (this.config.endpoints!.bulkCreate) {
            const traceId = internalContext?.traceId
            const trace = (typeof traceId === 'string' && traceId)
                ? { traceId, requestId: this.requestIdSequencer.next(traceId) }
                : undefined
            const ctx = trace && internalContext ? internalContext.with({ requestId: trace.requestId }) : internalContext
            return await this.client.bulkCreate(
                items,
                trace ? { [TRACE_ID_HEADER]: trace.traceId, [REQUEST_ID_HEADER]: trace.requestId } : undefined,
                ctx
            )
        }

        await this.executors.bulkPut(items, internalContext)
    }

    async delete(key: StoreKey, internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.sync?.enabled === true) {
            const op = this.buildSyncDeleteOp(key)
            const res = await this.orchestrator.pushOrQueueSyncOps([op], { traceId: internalContext?.traceId })
            if (!res) return
            await this.handleSyncRejected(res.rejected, [op], internalContext)
            return
        }
        if (this.batchEngine) {
            try {
                const baseVersion = this.resolveLocalBaseVersion(key)
                return await this.batchEngine.enqueueDelete(this.resourceNameForBatch, { id: key, baseVersion }, internalContext)
            } catch (error) {
                this.onError(error as Error, 'delete(batch)')
                throw error
            }
        }
        const baseVersion = this.resolveLocalBaseVersion(key)
        const traceId = internalContext?.traceId
        const trace = (typeof traceId === 'string' && traceId)
            ? { traceId, requestId: this.requestIdSequencer.next(traceId) }
            : undefined
        const ctx = trace && internalContext ? internalContext.with({ requestId: trace.requestId }) : internalContext
        await this.orchestrator.handleWithOfflineFallback(
            { type: 'delete', key },
            () => this.client.delete(
                key,
                { baseVersion },
                trace ? { [TRACE_ID_HEADER]: trace.traceId, [REQUEST_ID_HEADER]: trace.requestId } : undefined,
                ctx
            )
        )
    }

    async bulkDelete(keys: StoreKey[], internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.sync?.enabled === true) {
            const ops = keys.map(k => this.buildSyncDeleteOp(k))
            const res = await this.orchestrator.pushOrQueueSyncOps(ops, { traceId: internalContext?.traceId })
            if (!res) return
            await this.handleSyncRejected(res.rejected, ops, internalContext)
            return
        }
        if (!keys.length) return
        await Promise.all(keys.map(k => this.delete(k, internalContext)))
    }

    async get(key: StoreKey, internalContext?: ObservabilityContext): Promise<T | undefined> {
        if (this.batchEngine) {
            const params: FindManyOptions<T> = {
                where: { id: key } as any,
                limit: 1,
                includeTotal: false
            }

            try {
                const result = await this.batchEngine.enqueueQuery(
                    this.resourceNameForBatch,
                    params,
                    () => this.executors.findMany(params, internalContext),
                    internalContext
                )

                return result.data[0]
            } catch (error) {
                this.onError(error as Error, 'get(batch-fallback)')
            }
        }

        return this.executors.get(key, internalContext)
    }

    async bulkGet(keys: StoreKey[], internalContext?: ObservabilityContext): Promise<(T | undefined)[]> {
        if (!keys.length) return []

        // 若启用 batch，则将 bulkGet 转为一次批量 query（where in），否则回退并发 GET
        if (this.batchEngine) {
            const uniqueKeys = Array.from(new Set(keys))
            const params: FindManyOptions<T> = { where: { id: { in: uniqueKeys } } as any, skipStore: false }

            try {
                const result = await this.batchEngine.enqueueQuery<T>(
                    this.resourceNameForBatch,
                    params,
                    () => this.executors.bulkGet(uniqueKeys, internalContext).then(list => list.filter((i): i is T => i !== undefined)),
                    internalContext
                )

                const data = result.data

                const map = new Map<StoreKey, T>()
                data.forEach(item => {
                    const id = (item as any)?.id
                    if (id !== undefined) map.set(id, item)
                })

                // 保持与输入 keys 相同的顺序与重复
                return keys.map(key => map.get(key))
            } catch (error) {
                // 失败时回退到原有并发 GET
                this.onError(error as Error, 'bulkGet(batch-fallback)')
            }
        }

        return this.executors.bulkGet(keys, internalContext)
    }

    async getAll(filter?: (item: T) => boolean, internalContext?: ObservabilityContext): Promise<T[]> {
        if (this.batchEngine) {
            try {
                const result = await this.batchEngine.enqueueQuery<T>(
                    this.resourceNameForBatch,
                    undefined,
                    () => this.executors.getAll(filter, internalContext),
                    internalContext
                )

                return filter ? result.data.filter(filter) : result.data
            } catch (error) {
                this.onError(error as Error, 'getAll(batch-fallback)')
            }
        }

        return this.executors.getAll(filter, internalContext)
    }

    async findMany(
        options?: FindManyOptions<T>,
        internalContext?: ObservabilityContext
    ): Promise<{ data: T[]; pageInfo?: PageInfo }> {
        if (this.batchEngine) {
            return this.batchEngine.enqueueQuery(
                this.resourceNameForBatch,
                options,
                () => this.executors.findMany(options, internalContext),
                internalContext
            )
        }
        return this.executors.findMany(options, internalContext)
    }

    async applyPatches(
        patches: Patch[],
        metadata: PatchMetadata,
        internalContext?: ObservabilityContext
    ): Promise<{ created?: T[] } | void> {
        if (this.config.sync?.enabled === true) {
            return this.applyPatchesViaSync(patches, metadata, internalContext)
        }
        const supportsPatch = !!this.config.endpoints!.patch
        const usePatchForUpdates = this.usePatchForUpdate && supportsPatch
        const nextTraceHeaders = () => {
            const traceId = metadata.traceId
            if (typeof traceId !== 'string' || !traceId) return undefined
            const requestId = this.requestIdSequencer.next(traceId)
            return {
                traceId,
                requestId,
                headers: {
                    [TRACE_ID_HEADER]: traceId,
                    [REQUEST_ID_HEADER]: requestId
                }
            }
        }

        const patchesByItemId = new Map<StoreKey, Patch[]>()
        patches.forEach(patch => {
            const itemId = patch.path[0] as StoreKey
            if (!patchesByItemId.has(itemId)) patchesByItemId.set(itemId, [])
            patchesByItemId.get(itemId)!.push(patch)
        })

        const tasks: Promise<any>[] = []
        const createdResults: T[] = []

        const handleCreate = (id: StoreKey, value: T) => {
            if (this.batchEngine) {
                tasks.push(this.batchEngine.enqueueCreate(
                    this.resourceNameForBatch,
                    value,
                    internalContext
                ).then((res: any) => {
                    if (res && typeof res === 'object' && (res as any).id !== undefined) {
                        createdResults.push(res as T)
                    }
                    return res
                }))
                return
            }
            const trace = nextTraceHeaders()
            const ctx = trace && internalContext ? internalContext.with({ requestId: trace.requestId }) : internalContext
            tasks.push(this.client.create(
                id,
                value,
                trace?.headers,
                ctx
            ).then((res: any) => {
                if (res && typeof res === 'object' && (res as any).id !== undefined) {
                    createdResults.push(res as T)
                }
                return res
            }))
        }

        const handleDelete = (id: StoreKey) => {
            if (this.batchEngine) {
                const baseVersion = this.resolveLocalBaseVersion(id)
                tasks.push(
                    this.batchEngine.enqueueDelete(
                        this.resourceNameForBatch,
                        { id, baseVersion },
                        internalContext
                    )
                )
                return
            }
            const trace = nextTraceHeaders()
            const ctx = trace && internalContext ? internalContext.with({ requestId: trace.requestId }) : internalContext
            const baseVersion = this.resolveLocalBaseVersion(id)
            tasks.push(this.orchestrator.handleWithOfflineFallback(
                { type: 'delete', key: id },
                () => this.client.delete(
                    id,
                    { baseVersion },
                    trace?.headers,
                    ctx
                )
            ))
        }

        const handlePatch = (id: StoreKey, itemPatches: Patch[]) => {
            const baseVersion = this.resolveLocalBaseVersion(id)
            if (this.batchEngine) {
                tasks.push(
                    this.batchEngine.enqueuePatch(
                        this.resourceNameForBatch,
                        {
                            id,
                            patches: itemPatches,
                            baseVersion,
                            timestamp: metadata.timestamp
                        },
                        internalContext
                    )
                )
                return
            }
            const trace = nextTraceHeaders()
            const ctx = trace && internalContext ? internalContext.with({ requestId: trace.requestId }) : internalContext
            tasks.push(this.client.patch(
                id,
                itemPatches,
                { ...metadata, baseVersion },
                trace?.headers,
                ctx
            ))
        }

        const handlePut = async (id: StoreKey, itemPatches: Patch[]) => {
            // 如果 patch 在根路径提供了完整值，直接用；否则需要当前值套 patch
            const rootReplace = itemPatches.find(p => (p.op === 'add' || p.op === 'replace') && p.path.length === 1)
            let next: any
            if (rootReplace) {
                next = rootReplace.value
            } else {
                const current = await this.executors.get(id, internalContext)
                if (current === undefined) throw new Error(`Item ${id} not found for put`)
                next = applyPatches(current as any, itemPatches)
            }

            if (this.batchEngine) {
                const baseVersion = this.resolveLocalBaseVersion(id, next)
                tasks.push(
                    this.batchEngine.enqueuePatch(
                        this.resourceNameForBatch,
                        {
                            id,
                            patches: [{ op: 'replace', path: [id], value: next }] as any,
                            baseVersion,
                            timestamp: metadata.timestamp ?? Date.now()
                        },
                        internalContext
                    )
                )
                return
            }

            const trace = nextTraceHeaders()
            const ctx = trace && internalContext ? internalContext.with({ requestId: trace.requestId }) : internalContext
            const baseVersion = this.resolveLocalBaseVersion(id, next)
            const payload = (next && typeof next === 'object') ? ({ ...(next as any), baseVersion } as any) : next
            tasks.push(this.orchestrator.handleWithOfflineFallback(
                { type: 'put', key: id, value: payload },
                () => this.client.put(
                    id,
                    payload,
                    trace?.headers,
                    ctx
                )
            ))
        }

        for (const [id, itemPatches] of patchesByItemId.entries()) {
            const isDelete = itemPatches.some(p => p.op === 'remove' && p.path.length === 1)
            if (isDelete) {
                handleDelete(id)
                continue
            }

            const rootAdd = itemPatches.find(p => p.op === 'add' && p.path.length === 1)
            const isCreate = Boolean(rootAdd)

            if (isCreate) {
                handleCreate(id, rootAdd!.value as T)
                continue
            }

            if (usePatchForUpdates) {
                handlePatch(id, itemPatches)
            } else {
                await handlePut(id, itemPatches)
            }
        }

        await Promise.all(tasks)

        if (createdResults.length) {
            return { created: createdResults }
        }
    }

    private async startSync() {
        if (this.syncHub) return
        if (this.config.sync?.enabled !== true) return
        if (!this.storeAccess) return

        const mode = this.config.sync?.mode ?? 'sse'
        const pullLimit = this.config.sync?.pullLimit ?? 200
        const pollIntervalMs = this.config.sync?.pollIntervalMs ?? 2000
        const endpoints = {
            pull: this.config.sync?.endpoints?.pull ?? '/sync/pull',
            subscribe: this.config.sync?.endpoints?.subscribe ?? '/sync/subscribe'
        }

        const hubKey = `${this.config.baseURL}::${endpoints.pull}::${endpoints.subscribe}::${mode}`
        this.syncHub = getSyncHub(hubKey, () => new SyncHub({
            baseURL: this.config.baseURL,
            endpoints,
            mode,
            pollIntervalMs,
            pullLimit,
            cursorKey: this.config.sync?.cursorKey,
            deviceIdKey: this.config.sync?.deviceIdKey,
            getHeaders: this.getHeaders.bind(this),
            fetchFn: this.fetchWithRetry.bind(this),
            buildSubscribeUrl: this.config.sync?.sse?.buildSubscribeUrl,
            eventSourceFactory: this.config.sync?.sse?.eventSourceFactory
        }))
        this.orchestrator.setSyncHub(this.syncHub)

        const resource = this.resourceNameForBatch
        const handler = (changes: AtomaChange[]) => {
            this.bufferedChanges.push(...changes)
            if (this.pendingChangeFlush) return
            this.pendingChangeFlush = setTimeout(() => {
                this.pendingChangeFlush = undefined
                void this.flushBufferedChanges()
            }, 0)
        }
        this.syncHandler = handler
        this.syncHub.register(resource, handler)
    }

    private stopSync() {
        if (this.pendingChangeFlush) {
            clearTimeout(this.pendingChangeFlush)
            this.pendingChangeFlush = undefined
        }
        this.bufferedChanges = []

        if (this.syncHub && this.syncHandler) {
            this.syncHub.unregister(this.resourceNameForBatch, this.syncHandler)
        }
        this.syncHandler = undefined
        this.syncHub = undefined
        this.orchestrator.setSyncHub(undefined)
    }

    private async flushBufferedChanges() {
        const changes = this.bufferedChanges
        this.bufferedChanges = []
        if (!changes.length) return
        if (!this.storeAccess) return

        const pending = this.orchestrator.getPendingEntityKeys()

        const upsertIds = new Set<StoreKey>()
        const deleteIds = new Set<StoreKey>()

        for (const c of changes) {
            const id = c?.id
            if (id === undefined || id === null) continue
            const key: StoreKey = (typeof id === 'string' && /^[0-9]+$/.test(id)) ? Number(id) : id
            if (pending.has(`${this.resourceNameForBatch}:${String(key)}`)) continue
            if (c.kind === 'delete') {
                deleteIds.add(key)
            } else {
                upsertIds.add(key)
            }
        }

        if (!upsertIds.size && !deleteIds.size) return

        const fetched = upsertIds.size
            ? await this.bulkGet(Array.from(upsertIds))
            : []

        const items = fetched.filter((i): i is T => i !== undefined)
        await this.applyRemoteWriteback({ upserts: items, deletes: Array.from(deleteIds) })
    }

    private async applyRemoteWriteback(args: { upserts: T[]; deletes: StoreKey[] }) {
        const access = this.storeAccess
        if (!access) return

        const before = access.jotaiStore.get(access.atom)
        const after = new Map(before)
        let changed = false

        args.deletes.forEach(id => {
            if (after.has(id)) {
                after.delete(id)
                changed = true
            }
        })

        const preserveReference = (incoming: T): T => {
            const existing = before.get((incoming as any).id)
            if (!existing) return incoming
            const keys = new Set([...Object.keys(existing as any), ...Object.keys(incoming as any)])
            for (const key of keys) {
                if ((existing as any)[key] !== (incoming as any)[key]) {
                    return incoming
                }
            }
            return existing
        }

        for (const raw of args.upserts) {
            const transformed = access.transform ? access.transform(raw) : raw
            const validated = await validateWithSchema(transformed, access.schema as any)
            const item = preserveReference(validated)
            const id = (item as any).id
            const prev = before.get(id)
            if (prev !== item) changed = true
            after.set((item as any).id, item)
        }

        if (!changed) return
        commitAtomMapUpdate({
            jotaiStore: access.jotaiStore,
            atom: access.atom,
            before,
            after,
            context: access.context,
            indexes: (access.indexes as StoreIndexes<T>) ?? null
        })
    }

    private resolveLocalBaseVersion(id: StoreKey, value?: any): number {
        const versionFromValue = value && typeof value === 'object' ? (value as any).version : undefined
        if (typeof versionFromValue === 'number' && Number.isFinite(versionFromValue)) return versionFromValue
        const fromStore = this.storeAccess?.jotaiStore.get(this.storeAccess.atom).get(id) as any
        const v = fromStore?.version
        if (typeof v === 'number' && Number.isFinite(v)) return v
        return 0
    }

    private buildSyncPutOp(id: StoreKey, value: T): SyncQueuedOperation {
        const baseVersion = this.resolveLocalBaseVersion(id, value)
        return {
            idempotencyKey: `w_${this.generateOperationId()}`,
            resource: this.resourceNameForBatch,
            kind: 'patch',
            id,
            baseVersion,
            timestamp: Date.now(),
            patches: [{ op: 'replace', path: [id], value }] as any
        }
    }

    private buildSyncDeleteOp(id: StoreKey): SyncQueuedOperation {
        const baseVersion = this.resolveLocalBaseVersion(id)
        return {
            idempotencyKey: `w_${this.generateOperationId()}`,
            resource: this.resourceNameForBatch,
            kind: 'delete',
            id,
            baseVersion,
            timestamp: Date.now()
        }
    }

    private generateOperationId(): string {
        if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
            return (crypto as any).randomUUID()
        }
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`
    }

    private async applyPatchesViaSync(
        patches: Patch[],
        metadata: PatchMetadata,
        internalContext?: ObservabilityContext
    ): Promise<{ created?: T[] } | void> {
        const patchesByItemId = new Map<StoreKey, Patch[]>()
        patches.forEach(patch => {
            const itemId = patch.path[0] as StoreKey
            if (!patchesByItemId.has(itemId)) patchesByItemId.set(itemId, [])
            patchesByItemId.get(itemId)!.push(patch)
        })

        const createOps: Array<{ id: StoreKey; op: SyncQueuedOperation }> = []
        const ops: SyncQueuedOperation[] = []

        for (const [id, itemPatches] of patchesByItemId.entries()) {
            const isDelete = itemPatches.some(p => p.op === 'remove' && p.path.length === 1)
            if (isDelete) {
                ops.push(this.buildSyncDeleteOp(id))
                continue
            }

            const rootAdd = itemPatches.find(p => p.op === 'add' && p.path.length === 1)
            const isCreate = Boolean(rootAdd)
            if (isCreate) {
                const op: SyncQueuedOperation = {
                    idempotencyKey: `w_${this.generateOperationId()}`,
                    resource: this.resourceNameForBatch,
                    kind: 'create',
                    id,
                    timestamp: metadata.timestamp,
                    data: rootAdd!.value
                }
                createOps.push({ id, op })
                ops.push(op)
                continue
            }

            const baseVersion = this.resolveLocalBaseVersion(id)
            ops.push({
                idempotencyKey: `w_${this.generateOperationId()}`,
                resource: this.resourceNameForBatch,
                kind: 'patch',
                id,
                baseVersion,
                timestamp: metadata.timestamp,
                patches: itemPatches
            })
        }

        const res = await this.orchestrator.pushOrQueueSyncOps(
            ops,
            { traceId: internalContext?.traceId }
        )

        if (!res) return

        // 更新游标，避免订阅延迟
        if (this.syncHub && typeof res.serverCursor === 'number') {
            await this.syncHub.advanceCursor(res.serverCursor)
        }

        // 处理 conflict：rejected 携带 currentValue/currentVersion
        await this.handleSyncRejected(res.rejected, ops, internalContext)

        await this.applyAckedVersions(res.acked.map(a => ({
            id: (typeof a.id === 'string' && /^[0-9]+$/.test(a.id)) ? Number(a.id) : a.id as any,
            serverVersion: a.serverVersion
        })))

        // create：二次拉取最终态（为了 rewrite temp id）
        if (createOps.length) {
            const ackedCreate = res.acked.filter(a => createOps.some(c => c.op.idempotencyKey === a.idempotencyKey))
            const ids = ackedCreate.map(a => (typeof a.id === 'string' && /^[0-9]+$/.test(a.id)) ? Number(a.id) : a.id as any)
            const fetched = await this.executors.bulkGet(ids as any)
            const created = fetched.filter((i): i is T => i !== undefined)
            return created.length ? { created } : undefined
        }
    }

    private async handleSyncRejected(
        rejected: any[],
        originalOps: SyncQueuedOperation[],
        internalContext?: ObservabilityContext
    ) {
        if (!rejected || !rejected.length) return
        const byKey = new Map<string, SyncQueuedOperation>()
        originalOps.forEach(op => byKey.set(op.idempotencyKey, op))

        for (const r of rejected) {
            const idempotencyKey = r?.idempotencyKey
            const op = typeof idempotencyKey === 'string' ? byKey.get(idempotencyKey) : undefined
            if (!op) continue

            const err = r?.error
            const code = err?.code
            const currentValue = r?.currentValue ?? err?.details?.currentValue
            const currentVersion = r?.currentVersion ?? err?.details?.currentVersion

            if (code === 'CONFLICT' && currentValue !== undefined && this.storeAccess) {
                // 默认策略：server-wins -> 写回 server currentValue；last-write-wins/retry-local -> 重新入队 patch（以 currentVersion 作为 baseVersion）
                const decision = this.config.conflict?.onConflict
                    ? await this.config.conflict.onConflict({
                        key: (op as any).id,
                        local: op.kind === 'patch' ? op.patches : (op as any).data,
                        server: { currentValue, currentVersion },
                        metadata: undefined
                    })
                    : undefined

                const resolution = this.config.conflict?.resolution ?? 'last-write-wins'
                const effective = decision
                    ? decision
                    : (resolution === 'server-wins' ? 'accept-server' : (resolution === 'manual' ? 'ignore' : 'retry-local'))

                if (effective === 'accept-server') {
                    await this.applyRemoteWriteback({ upserts: [currentValue], deletes: [] })
                    continue
                }

                if (effective === 'retry-local' && typeof currentVersion === 'number') {
                    if (op.kind === 'patch') {
                        const retry: SyncQueuedOperation = {
                            ...op,
                            idempotencyKey: `w_${this.generateOperationId()}`,
                            baseVersion: currentVersion,
                            timestamp: Date.now()
                        } as any
                        await this.orchestrator.pushOrQueueSyncOps([retry], { traceId: internalContext?.traceId })
                    }

                    if (op.kind === 'delete') {
                        const retry: SyncQueuedOperation = {
                            ...op,
                            idempotencyKey: `w_${this.generateOperationId()}`,
                            baseVersion: currentVersion,
                            timestamp: Date.now()
                        } as any
                        await this.orchestrator.pushOrQueueSyncOps([retry], { traceId: internalContext?.traceId })
                    }
                }
            }
        }
    }

    private async applyAckedVersions(acked: Array<{ id: StoreKey; serverVersion: number }>) {
        const access = this.storeAccess
        if (!access) return
        if (!acked.length) return
        const before = access.jotaiStore.get(access.atom)
        const after = new Map(before)
        let changed = false
        for (const a of acked) {
            const cur = before.get(a.id) as any
            if (!cur || typeof cur !== 'object') continue
            if (cur.version === a.serverVersion) continue
            after.set(a.id, { ...cur, version: a.serverVersion })
            changed = true
        }
        if (!changed) return
        commitAtomMapUpdate({
            jotaiStore: access.jotaiStore,
            atom: access.atom,
            before,
            after,
            context: access.context,
            indexes: (access.indexes as StoreIndexes<T>) ?? null
        })
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
        init?: RequestInit,
        attemptNumber = 1,
        startedAt = Date.now()
    ): Promise<Response> {
        try {
            const response = await fetch(input, init)

            // Don't retry client errors (4xx except 409)
            if (response.status >= 400 && response.status < 500 && response.status !== 409) {
                return response
            }

            // Retry server errors (5xx)
            if (response.status >= 500) {
                throw new Error(`Server error: ${response.status}`)
            }

            return response
        } catch (error) {
            const maxAttempts = this.config.retry?.maxAttempts ?? 3

            if (attemptNumber >= maxAttempts) {
                throw error
            }

            const elapsed = Date.now() - startedAt
            if (elapsed >= this.maxRetryElapsedMs) {
                throw error
            }

            // Calculate backoff delay
            const backoff = this.config.retry?.backoff ?? 'exponential'
            const initialDelay = this.config.retry?.initialDelay ?? 1000
            const delay = calculateBackoff(backoff, initialDelay, attemptNumber, this.config.retry?.jitter === true)

            console.log(`Retry attempt ${attemptNumber}/${maxAttempts} after ${delay}ms`)

            await new Promise(resolve => setTimeout(resolve, delay))

            return this.fetchWithRetry(input, init, attemptNumber + 1, startedAt)
        }
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

    private resolveClientVersion(key: StoreKey, value: T): any {
        const versionField = this.config.version?.field
        if (versionField && value && typeof value === 'object' && (value as any)[versionField] !== undefined) {
            return (value as any)[versionField]
        }
        return this.etagManager.get(key)
    }

    /**
     * Lightweight sender wrapper to satisfy RequestSender signature
     */
    private readonly sender = (url: RequestInfo | URL, init?: RequestInit) => this.fetchWithRetry(url, init ?? {})
}
