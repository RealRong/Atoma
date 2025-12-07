import { Patch } from 'immer'
import { FindManyOptions, IAdapter, PatchMetadata, StoreKey, PageInfo, Entity } from '../core/types'
import { calculateBackoff } from './http/retry'
import { applyPatchesWithFallback } from './http/patch'
import { resolveConflict } from './http/conflict'
import { makeUrl, RequestSender, resolveEndpoint } from './http/request'
import { ETagManager } from './http/etagManager'
import { BulkOperationHandler } from './http/bulkOperations'
import { HTTPEventEmitter } from './http/eventEmitter'
import { HTTPClient, ConflictHandler, ClientConfig } from './http/client'
import { SyncOrchestrator } from './http/syncOrchestrator'
import { createOperationExecutors, OperationExecutors } from './http/operationExecutors'
import type { QueuedOperation } from './http/offlineQueue'

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

    /** Concurrency limits */
    concurrency?: ConcurrencyConfig

    /** Bulk operation behavior */
    bulk?: BulkConfig

    /** Event callbacks */
    events?: EventCallbacks

    /** 
     * Response Parser (Anti-Corruption Layer) 
     * Pure function to map arbitrary backend response to Atoma Standard Envelope
     */
    responseParser?: ResponseParser<T>

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
        this.orchestrator = new SyncOrchestrator(config, {
            queueStorageKey: this.queueStorageKey,
            eventEmitter: this.eventEmitter,
            client: this.client,
            retry: config.retry
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
    }

    dispose(): void {
        this.orchestrator.dispose()
        // Clear ETag cache to free memory
        this.etagManager.clear()
    }

    async put(key: StoreKey, value: T): Promise<void> {
        return this.executors.put(key, value)
    }

    async bulkPut(items: T[]): Promise<void> {
        return this.executors.bulkPut(items)
    }

    async delete(key: StoreKey): Promise<void> {
        return this.executors.delete(key)
    }

    async bulkDelete(keys: StoreKey[]): Promise<void> {
        return this.executors.bulkDelete(keys)
    }

    async get(key: StoreKey): Promise<T | undefined> {
        return this.executors.get(key)
    }

    async bulkGet(keys: StoreKey[]): Promise<(T | undefined)[]> {
        return this.executors.bulkGet(keys)
    }

    async getAll(filter?: (item: T) => boolean): Promise<T[]> {
        return this.executors.getAll(filter)
    }

    async findMany(options?: FindManyOptions<T>): Promise<{ data: T[]; pageInfo?: PageInfo } | T[]> {
        return this.executors.findMany(options)
    }

    async applyPatches(patches: Patch[], metadata: PatchMetadata): Promise<void> {
        const supportsPatch = !!this.config.endpoints!.patch
        return applyPatchesWithFallback<T>(patches, metadata, {
            sendDeleteRequest: this.client.delete.bind(this.client),
            sendCreateRequest: this.client.create.bind(this.client),
            sendPatchRequest: this.client.patch.bind(this.client),
            sendPutRequest: this.client.put.bind(this.client)
        }, supportsPatch)
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
        input: RequestInfo,
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

    /**
     * Lightweight sender wrapper to satisfy RequestSender signature
     */
    private readonly sender = (url: string, init?: RequestInit) => this.fetchWithRetry(url, init ?? {})
}
