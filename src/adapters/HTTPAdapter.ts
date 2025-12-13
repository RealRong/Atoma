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

export interface QueryConfig<T> {
    strategy?: 'REST' | 'Django' | 'GraphQL' | 'passthrough'
    serializer?: (options: FindManyOptions<T>) => URLSearchParams | object
    customFn?: (options: FindManyOptions<T>) => Promise<{ data: T[]; pageInfo?: PageInfo } | T[]>
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
                put: (item) => this.put(item.id, item),
                delete: (key) => this.delete(key)
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
            retry: config.retry,
            devtools: config.devtools ?? getGlobalDevtools()
        })

        this.executors = createOperationExecutors({
            config: this.config,
            client: this.client,
            bulkOps: this.bulkOps,
            etagManager: this.etagManager,
            fetchWithRetry: this.fetchWithRetry.bind(this),
            getHeaders: this.getHeaders.bind(this),
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
        this.orchestrator.dispose()
        // Clear ETag cache to free memory
        this.etagManager.clear()
        this.batchEngine?.dispose()
    }

    async put(key: StoreKey, value: T): Promise<void> {
        if (this.batchEngine) {
            const clientVersion = this.resolveClientVersion(key, value)
            try {
                return await this.batchEngine.enqueueUpdate(
                    this.resourceNameForBatch,
                    { id: key, data: value, clientVersion }
                )
            } catch (error) {
                this.onError(error as Error, 'put(batch)')
                throw error
            }
        }
        return this.executors.put(key, value)
    }

    async bulkPut(items: T[]): Promise<void> {
        return this.executors.bulkPut(items)
    }

    async bulkCreate(items: T[]): Promise<T[] | void> {
        if (this.batchEngine) {
            const created = await Promise.all(items.map(item => {
                return this.batchEngine!.enqueueCreate(
                    this.resourceNameForBatch,
                    item
                )
            }))
            return created
        }

        if (this.config.endpoints!.bulkCreate) {
            return await this.client.bulkCreate(items)
        }

        await this.executors.bulkPut(items)
    }

    async delete(key: StoreKey): Promise<void> {
        if (this.batchEngine) {
            try {
                return await this.batchEngine.enqueueDelete(this.resourceNameForBatch, key)
            } catch (error) {
                this.onError(error as Error, 'delete(batch)')
                throw error
            }
        }
        return this.executors.delete(key)
    }

    async bulkDelete(keys: StoreKey[]): Promise<void> {
        return this.executors.bulkDelete(keys)
    }

    async get(key: StoreKey): Promise<T | undefined> {
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
                    () => this.executors.findMany(params)
                )

                const data: T[] = Array.isArray(result)
                    ? result as T[]
                    : Array.isArray((result as any)?.data)
                        ? (result as any).data as T[]
                        : []

                return data[0]
            } catch (error) {
                this.onError(error as Error, 'get(batch-fallback)')
            }
        }

        return this.executors.get(key)
    }

    async bulkGet(keys: StoreKey[]): Promise<(T | undefined)[]> {
        if (!keys.length) return []

        // 若启用 batch，则将 bulkGet 转为一次批量 query（where in），否则回退并发 GET
        if (this.batchEngine) {
            const uniqueKeys = Array.from(new Set(keys))
            const params: FindManyOptions<T> = { where: { id: { in: uniqueKeys } } as any, skipStore: false }

            try {
                const result = await this.batchEngine.enqueueQuery<T>(
                    this.resourceNameForBatch,
                    params,
                    () => this.executors.bulkGet(uniqueKeys).then(list => list.filter((i): i is T => i !== undefined))
                )

                const data: T[] = Array.isArray(result)
                    ? result as T[]
                    : Array.isArray((result as any)?.data)
                        ? (result as any).data as T[]
                        : []

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

        return this.executors.bulkGet(keys)
    }

    async getAll(filter?: (item: T) => boolean): Promise<T[]> {
        if (this.batchEngine) {
            try {
                const result = await this.batchEngine.enqueueQuery(
                    this.resourceNameForBatch,
                    undefined,
                    () => this.executors.getAll(filter)
                )

                const data: T[] = Array.isArray(result)
                    ? result as T[]
                    : Array.isArray((result as any)?.data)
                        ? (result as any).data as T[]
                        : []

                return filter ? data.filter(filter) : data
            } catch (error) {
                this.onError(error as Error, 'getAll(batch-fallback)')
            }
        }

        return this.executors.getAll(filter)
    }

    async findMany(options?: FindManyOptions<T>): Promise<{ data: T[]; pageInfo?: PageInfo } | T[]> {
        if (this.batchEngine) {
            return this.batchEngine.enqueueQuery(
                this.resourceNameForBatch,
                options,
                () => this.executors.findMany(options)
            )
        }
        return this.executors.findMany(options)
    }

    async applyPatches(patches: Patch[], metadata: PatchMetadata): Promise<{ created?: T[] } | void> {
        const supportsPatch = !!this.config.endpoints!.patch
        const usePatchForUpdates = this.usePatchForUpdate && supportsPatch

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
                tasks.push(
                    this.batchEngine.enqueueCreate(
                        this.resourceNameForBatch,
                        value
                    )
                )
                return
            }
            tasks.push(this.client.create(id, value))
        }

        const handleDelete = (id: StoreKey) => {
            if (this.batchEngine) {
                tasks.push(
                    this.batchEngine.enqueueDelete(
                        this.resourceNameForBatch,
                        id
                    )
                )
                return
            }
            tasks.push(this.executors.delete(id))
        }

        const handlePatch = (id: StoreKey, itemPatches: Patch[]) => {
            if (this.batchEngine) {
                tasks.push(
                    this.batchEngine.enqueuePatch(
                        this.resourceNameForBatch,
                        {
                            id,
                            patches: itemPatches,
                            baseVersion: metadata.baseVersion,
                            timestamp: metadata.timestamp
                        }
                    )
                )
                return
            }
            tasks.push(this.client.patch(id, itemPatches, metadata))
        }

        const handlePut = async (id: StoreKey, itemPatches: Patch[]) => {
            // 如果 patch 在根路径提供了完整值，直接用；否则需要当前值套 patch
            const rootReplace = itemPatches.find(p => (p.op === 'add' || p.op === 'replace') && p.path.length === 1)
            let next: any
            if (rootReplace) {
                next = rootReplace.value
            } else {
                const current = await this.executors.get(id)
                if (current === undefined) throw new Error(`Item ${id} not found for put`)
                next = applyPatches(current as any, itemPatches)
            }

            if (this.batchEngine) {
                const clientVersion = this.resolveClientVersion(id, next)
                tasks.push(
                    this.batchEngine.enqueueUpdate(
                        this.resourceNameForBatch,
                        { id, data: next, clientVersion }
                    )
                )
                return
            }

            tasks.push(this.executors.put(id, next))
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

        const results = await Promise.all(tasks)

        results.forEach(res => {
            if (res && typeof res === 'object' && (res as any).id !== undefined) {
                createdResults.push(res as T)
            }
        })

        if (createdResults.length) {
            return { created: createdResults }
        }
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
