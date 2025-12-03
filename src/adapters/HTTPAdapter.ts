import { Patch } from 'immer'
import { IAdapter, PatchMetadata, StoreKey } from '../core/types'

/**
 * HTTP adapter configuration
 */
export interface HTTPAdapterConfig<T> {
    /** Base URL for API */
    baseURL: string

    /** Endpoint templates */
    endpoints: {
        getOne: (id: StoreKey) => string
        getAll: () => string
        create: () => string
        update: (id: StoreKey) => string
        delete: (id: StoreKey) => string
        /** Optional: dedicated patch endpoint */
        patch?: (id: StoreKey) => string
    }

    /** Headers function (can be async for auth tokens) */
    headers?: () => Promise<Record<string, string>> | Record<string, string>

    /** Retry configuration */
    retry?: {
        maxAttempts: number
        backoff: 'exponential' | 'linear'
        initialDelay: number
        /** Stop retrying after this total duration (ms) */
        maxElapsedMs?: number
        /** Add jitter to avoid request thundering herd */
        jitter?: boolean
    }

    /** Conflict resolution strategy */
    conflictResolution?: 'last-write-wins' | 'server-wins' | 'manual'
    /** Optional hook to handle conflicts; return strategy override */
    onConflict?: (args: {
        key: StoreKey
        local: T | Patch[]
        server: any
        metadata?: PatchMetadata
    }) => Promise<'accept-server' | 'retry-local' | 'ignore'> | 'accept-server' | 'retry-local' | 'ignore'

    /** Version/ETag support */
    version?: {
        /** Field name on payload carrying version (e.g., version/etag) */
        field?: string
        /** Header to send If-Match with server-provided ETag */
        ifMatchHeader?: string
    }

    /** Offline queue configuration */
    offline?: {
        queueWrites: boolean
        maxQueueSize: number
        syncOnReconnect: boolean
    }

    /** Enable patch-based updates */
    supportsPatch?: boolean

    /** Event hooks for UI */
    events?: {
        onSyncStart?: (pending: number) => void
        onSyncComplete?: (remaining: number) => void
        onSyncError?: (error: Error, op: QueuedOperation) => void
        onQueueChange?: (size: number) => void
        onConflictResolved?: (serverValue: any, key: StoreKey) => void
    }
}

/**
 * Queued operation for offline support
 */
interface QueuedOperation {
    id: string
    type: 'put' | 'delete'
    key?: StoreKey
    value?: any
    timestamp: number
    retryCount?: number
}

/**
 * HTTP Adapter for RESTful APIs
 */
export class HTTPAdapter<T> implements IAdapter<T> {
    public readonly name: string
    private offlineQueue: QueuedOperation[] = []
    private isOnline: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true
    private syncInProgress: boolean = false
    private readonly queueStorageKey: string
    private readonly maxRetryElapsedMs: number
    private serverEtag?: string

    constructor(private config: HTTPAdapterConfig<T>) {
        this.name = config.baseURL
        this.queueStorageKey = `atoma:httpQueue:${this.name}`

        // Set defaults
        this.config.retry = config.retry || {
            maxAttempts: 3,
            backoff: 'exponential',
            initialDelay: 1000,
            maxElapsedMs: 10_000,
            jitter: true
        }
        // Derived defaults
        this.maxRetryElapsedMs = this.config.retry.maxElapsedMs ?? 10_000
        this.config.conflictResolution = config.conflictResolution || 'last-write-wins'
        this.config.offline = config.offline || {
            queueWrites: true,
            maxQueueSize: 100,
            syncOnReconnect: true
        }
        this.config.supportsPatch = config.supportsPatch ?? true

        // Listen for online/offline events (browser only)
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => {
                this.isOnline = true
                if (this.config.offline?.syncOnReconnect) {
                    this.syncOfflineQueue()
                }
            })

            window.addEventListener('offline', () => {
                this.isOnline = false
            })
        }

        // Load persisted queue
        this.restoreQueue()
    }

    async put(key: StoreKey, value: T): Promise<void> {
        if (!this.isOnline && this.config.offline?.queueWrites) {
            this.queueOperation({ id: this.generateOperationId(), type: 'put', key, value, timestamp: Date.now() })
            this.emitQueueChange()
            return
        }

        try {
            await this.sendPutRequest(key, value)
        } catch (error) {
            if (this.isNetworkError(error)) {
                if (this.config.offline?.queueWrites) {
                    this.queueOperation({ id: this.generateOperationId(), type: 'put', key, value, timestamp: Date.now() })
                    this.emitQueueChange()
                }
            } else {
                throw error
            }
        }
    }

    async bulkPut(items: T[]): Promise<void> {
        // For bulk operations, fall back to individual puts
        await Promise.all(items.map(item => this.put((item as any).id, item)))
    }

    async delete(key: StoreKey): Promise<void> {
        if (!this.isOnline && this.config.offline?.queueWrites) {
            this.queueOperation({ id: this.generateOperationId(), type: 'delete', key, timestamp: Date.now() })
            this.emitQueueChange()
            return
        }

        try {
            await this.sendDeleteRequest(key)
        } catch (error) {
            if (this.isNetworkError(error)) {
                if (this.config.offline?.queueWrites) {
                    this.queueOperation({ id: this.generateOperationId(), type: 'delete', key, timestamp: Date.now() })
                    this.emitQueueChange()
                }
            } else {
                throw error
            }
        }
    }

    async bulkDelete(keys: StoreKey[]): Promise<void> {
        await Promise.all(keys.map(key => this.delete(key)))
    }

    async get(key: StoreKey): Promise<T | undefined> {
        try {
            const url = `${this.config.baseURL}${this.config.endpoints.getOne(key)}`
            const headers = await this.getHeaders()

            const response = await this.fetchWithRetry(url, { headers })

            if (response.status === 404) {
                return undefined
            }

            this.captureEtag(response)
            const payload = await response.json()
            this.captureVersionFromBody(payload)
            return payload
        } catch (error) {
            this.onError(error as Error, `get(${key})`)
            return undefined
        }
    }

    async bulkGet(keys: StoreKey[]): Promise<(T | undefined)[]> {
        // Fetch items in parallel
        return await Promise.all(keys.map(key => this.get(key)))
    }

    async getAll(filter?: (item: T) => boolean): Promise<T[]> {
        try {
            const url = `${this.config.baseURL}${this.config.endpoints.getAll()}`
            const headers = await this.getHeaders()

            const response = await this.fetchWithRetry(url, { headers })
            this.captureEtag(response)
            const data = await response.json()
            this.captureVersionFromBody(data)

            // Handle different response formats
            const items = Array.isArray(data) ? data : (data.items || data.data || [])

            return filter ? items.filter(filter) : items
        } catch (error) {
            this.onError(error as Error, 'getAll')
            return []
        }
    }

    async applyPatches(patches: Patch[], metadata: PatchMetadata): Promise<void> {
        if (!this.config.supportsPatch) {
            // Fallback to individual operations
            return this.applyPatchesViaOperations(patches)
        }

        // Group patches by ID
        const patchesByItemId = new Map<StoreKey, Patch[]>()

        patches.forEach(patch => {
                const itemId = patch.path[0] as StoreKey
            if (!patchesByItemId.has(itemId)) {
                patchesByItemId.set(itemId, [])
            }
            patchesByItemId.get(itemId)!.push(patch)
        })

        for (const [itemId, itemPatches] of patchesByItemId.entries()) {
            const hasRemove = itemPatches.some(patch => patch.op === 'remove')
            if (hasRemove) {
                await this.sendDeleteRequest(itemId)
                continue
            }

            const addPatch = itemPatches.find(patch => patch.op === 'add')
            if (addPatch) {
                await this.sendCreateRequest(itemId, addPatch.value as T)
                continue
            }

            await this.sendPatchRequest(itemId, itemPatches, metadata)
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
     * Send PUT request for full object update
     */
    private async sendPutRequest(key: StoreKey, value: T): Promise<void> {
        const url = `${this.config.baseURL}${this.config.endpoints.update(key)}`
        const headers = await this.getHeaders()

        this.attachVersion(headers, value)

        const response = await this.fetchWithRetry(url, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...value,
                updatedAt: Date.now()
            })
        })

        if (response.status === 409) {
            await this.handleConflict(response, key, value)
        }
    }

    /**
     * Send POST request for create
     */
    private async sendCreateRequest(key: StoreKey, value: T): Promise<void> {
        const url = `${this.config.baseURL}${this.config.endpoints.create()}`
        const headers = await this.getHeaders()

        this.attachVersion(headers, value)

        await this.fetchWithRetry(url, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...value,
                id: key,
                createdAt: (value as any)?.createdAt ?? Date.now(),
                updatedAt: Date.now()
            })
        })
    }

    /**
     * Send PATCH request with Immer patches
     */
    private async sendPatchRequest(
        id: StoreKey,
        patches: Patch[],
        metadata: PatchMetadata
    ): Promise<void> {
        const patchEndpoint = this.config.endpoints.patch?.(id) || this.config.endpoints.update(id)
        const url = `${this.config.baseURL}${patchEndpoint}`
        const headers = await this.getHeaders()

        this.attachVersion(headers, metadata)

        const response = await this.fetchWithRetry(url, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                patches,
                baseVersion: metadata.baseVersion,
                timestamp: metadata.timestamp
            })
        })

        if (response.status === 409) {
            const conflict = await response.json()
            await this.handleConflict(response, id, patches, conflict, metadata)
        }
    }

    /**
     * Send DELETE request
     */
    private async sendDeleteRequest(key: StoreKey): Promise<void> {
        const url = `${this.config.baseURL}${this.config.endpoints.delete(key)}`
        const headers = await this.getHeaders()

        this.attachVersion(headers)

        await this.fetchWithRetry(url, {
            method: 'DELETE',
            headers
        })
    }

    /**
     * Handle conflict based on configured strategy
     */
    private async handleConflict(
        response: Response,
        key: StoreKey,
        localValue: T | Patch[],
        conflictBody?: any,
        metadata?: PatchMetadata
    ): Promise<void> {
        const serverData = conflictBody ?? (await response.json())
        this.captureEtag(response)
        this.captureVersionFromBody(serverData)

        // User hook takes precedence
        if (this.config.onConflict) {
            const decision = await this.config.onConflict({
                key,
                local: localValue,
                server: serverData,
                metadata
            })
            if (decision === 'retry-local') {
                await this.sendPutRequest(key, (localValue as any) as T)
                return
            }
            if (decision === 'accept-server') {
                console.info(`Conflict hook: accepting server version for item ${key}`)
                return
            }
            if (decision === 'ignore') {
                console.warn(`Conflict hook: ignoring conflict for item ${key}`)
                return
            }
        }

        switch (this.config.conflictResolution) {
            case 'last-write-wins': {
                const localUpdatedAt = (localValue as any)?.updatedAt ?? metadata?.timestamp
                const serverUpdatedAt = serverData.currentValue?.updatedAt ?? serverData.updatedAt

                if (localUpdatedAt && serverUpdatedAt && localUpdatedAt > serverUpdatedAt) {
                    // Retry once using PUT as authoritative
                    await this.sendPutRequest(key, (localValue as any) as T)
                } else {
                    console.warn(`Conflict: server newer, accepting server version for item ${key}`)
                    this.config.events?.onConflictResolved?.(serverData, key)
                }
                break
            }
            case 'server-wins': {
                console.info(`Conflict: accepting server version for item ${key}`)
                this.config.events?.onConflictResolved?.(serverData, key)
                break
            }
            case 'manual':
                console.warn(`Conflict requires manual resolution for item ${key}:`, serverData)
                break
            default:
                break
        }
    }

    /**
     * Fallback: apply patches via put/delete operations
     */
    private async applyPatchesViaOperations(patches: Patch[]): Promise<void> {
        for (const patch of patches) {
                const key = patch.path[0] as StoreKey

            if (patch.op === 'remove') {
                await this.delete(key)
                continue
            }

            if (patch.op === 'add') {
                await this.sendCreateRequest(key, patch.value as T)
                continue
            }

            if (patch.op === 'replace') {
                await this.sendPutRequest(key, patch.value as T)
            }
        }
    }

    /**
     * Fetch with retry logic
     */
    private async fetchWithRetry(
        url: string,
        options: RequestInit,
        attemptNumber = 1,
        startedAt = Date.now()
    ): Promise<Response> {
        try {
            const response = await fetch(url, options)

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
            const maxAttempts = this.config.retry!.maxAttempts

            if (attemptNumber >= maxAttempts) {
                throw error
            }

            const elapsed = Date.now() - startedAt
            if (elapsed >= this.maxRetryElapsedMs) {
                throw error
            }

            // Calculate backoff delay
            const delay = this.calculateBackoff(attemptNumber, this.config.retry!.jitter === true)

            console.log(`Retry attempt ${attemptNumber}/${maxAttempts} after ${delay}ms`)

            await new Promise(resolve => setTimeout(resolve, delay))

            return this.fetchWithRetry(url, options, attemptNumber + 1, startedAt)
        }
    }

    /**
     * Calculate exponential or linear backoff
     */
    private calculateBackoff(attempt: number, jitter: boolean): number {
        const { backoff, initialDelay } = this.config.retry!

        if (backoff === 'exponential') {
            const base = initialDelay * Math.pow(2, attempt - 1)
            return jitter ? this.addJitter(base) : base
        } else {
            const base = initialDelay * attempt
            return jitter ? this.addJitter(base) : base
        }
    }

    private addJitter(base: number): number {
        const jitter = Math.random() * 0.3 * base
        return base + jitter
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
     * Check if error is network-related
     */
    private isNetworkError(error: any): boolean {
        return (
            error.message?.includes('fetch') ||
            error.message?.includes('network') ||
            error.code === 'ECONNREFUSED' ||
            !this.isOnline
        )
    }

    /**
     * Queue operation for offline sync
     */
    private queueOperation(op: QueuedOperation): void {
        // Replace existing pending op with same key/type to keep latest payload (dedupe)
        const existingIndex = this.offlineQueue.findIndex(
            item => item.type === op.type && item.key === op.key
        )
        if (existingIndex >= 0) {
            this.offlineQueue[existingIndex] = op
        } else {
            if (this.offlineQueue.length >= this.config.offline!.maxQueueSize) {
                // Remove oldest operation
                this.offlineQueue.shift()
            }
            this.offlineQueue.push(op)
        }
        this.persistQueue()
        this.emitQueueChange()
    }

    /**
     * Sync offline queue when connection is restored
     */
    private async syncOfflineQueue(): Promise<void> {
        if (this.syncInProgress || this.offlineQueue.length === 0) {
            return
        }

        this.syncInProgress = true
        this.emitSyncStart()
        console.log(`Syncing ${this.offlineQueue.length} queued operations...`)

        const queue = [...this.offlineQueue]

        const stillPending: QueuedOperation[] = []

        for (const op of queue) {
            try {
                if (op.type === 'put' && op.key && op.value) {
                    await this.sendPutRequest(op.key, op.value)
                } else if (op.type === 'delete' && op.key) {
                    await this.sendDeleteRequest(op.key)
                }
                // drop from queue on success
            } catch (error) {
                const retryCount = (op.retryCount || 0) + 1
                if (retryCount < this.config.retry!.maxAttempts) {
                    stillPending.push({
                        ...op,
                        retryCount
                    })
                } else {
                    this.emitSyncError(error as Error, op)
                    console.error('Dropping queued operation after max retries:', {
                        opType: op.type,
                        key: op.key,
                        error
                    })
                }
            }
        }

        this.offlineQueue = stillPending
        this.syncInProgress = false
        console.log(`Sync complete. ${this.offlineQueue.length} operations remaining in queue.`)
        this.persistQueue()
        this.emitQueueChange()
        this.emitSyncComplete()
    }

    /**
     * Persist offline queue to storage (best effort)
     */
    private persistQueue(): void {
        if (typeof localStorage === 'undefined') return
        try {
            localStorage.setItem(this.queueStorageKey, JSON.stringify(this.offlineQueue))
        } catch {
            // ignore storage errors
        }
    }

    /**
     * Restore queue from storage
     */
    private restoreQueue(): void {
        if (typeof localStorage === 'undefined') return
        try {
            const raw = localStorage.getItem(this.queueStorageKey)
            if (raw) {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed)) {
                    this.offlineQueue = parsed
                        .map((item: any) => ({
                            ...item,
                            id: item.id || this.generateOperationId()
                        }))
                        // Deduplicate on load as well
                        .reduce<QueuedOperation[]>((acc, item) => {
                            const idx = acc.findIndex(op => op.type === item.type && op.key === item.key)
                            if (idx >= 0) {
                                acc[idx] = item
                            } else {
                                acc.push(item)
                            }
                            return acc
                        }, [])
                }
            }
        } catch {
            // ignore parse errors
        }
    }

    /**
     * Generate an idempotency key for queued operations
     */
    private generateOperationId(): string {
        if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
            return (crypto as any).randomUUID()
        }
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`
    }

    /**
     * Attach version/etag info to outgoing request headers
     */
    private attachVersion(headers: Record<string, string>, payload?: any) {
        const version = this.config.version
        if (!version) return

        if (version.ifMatchHeader && this.serverEtag) {
            headers[version.ifMatchHeader] = this.serverEtag
        } else if (version.field && payload && (payload as any)[version.field] !== undefined) {
            headers['If-Match'] = String((payload as any)[version.field])
        }
    }

    /**
     * Capture ETag from response headers
     */
    private captureEtag(response: Response) {
        const etag = response.headers.get('ETag')
        if (etag) {
            this.serverEtag = etag
        }
    }

    /**
     * Capture version field from body if configured
     */
    private captureVersionFromBody(body: any) {
        const version = this.config.version
        if (!version?.field || !body) return

        if (Array.isArray(body)) {
            const first = body[0]
            if (first && version.field in first) {
                this.serverEtag = String(first[version.field])
            }
        } else if (version.field in body) {
            this.serverEtag = String(body[version.field])
        } else if (body.data && version.field in body.data) {
            this.serverEtag = String(body.data[version.field])
        }
    }

    private emitSyncStart() {
        this.config.events?.onSyncStart?.(this.offlineQueue.length)
    }

    private emitSyncComplete() {
        this.config.events?.onSyncComplete?.(this.offlineQueue.length)
    }

    private emitSyncError(error: Error, op: QueuedOperation) {
        this.config.events?.onSyncError?.(error, op)
    }

    private emitQueueChange() {
        this.config.events?.onQueueChange?.(this.offlineQueue.length)
    }
}
