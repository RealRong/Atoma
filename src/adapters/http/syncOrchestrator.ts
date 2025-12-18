import { HTTPEventEmitter } from './eventEmitter'
import { OfflineQueue, QueuedOperation } from './offlineQueue'
import { QueueSynchronizer } from './queueSync'
import { NetworkStateManager } from './networkState'
import type { HTTPClient } from './client'
import type { HTTPAdapterConfig, RetryConfig } from '../HTTPAdapter'
import type { DevtoolsBridge } from '../../devtools/types'
import { registerGlobalQueue } from '../../devtools/global'
import type { StoreKey, Entity } from '../../core/types'
import { SyncOfflineQueue, type SyncQueuedOperation } from './syncOfflineQueue'
import type { SyncPushOp, SyncPushResponse } from '../../protocol/sync'
import { makeUrl } from './request'
import { createSyncCursorStorage } from './syncCursor'
import type { SyncHub } from './syncHub'
import type { RequestIdSequencer } from '../../observability/trace'
import { REQUEST_ID_HEADER, TRACE_ID_HEADER } from '../../protocol/trace'

type OpKind = 'put' | 'delete'

/**
 * Encapsulates network state + offline queue + sync logic so HTTPAdapter stays thin.
 */
export class SyncOrchestrator<T extends Entity> {
    private networkState: NetworkStateManager
    private offlineQueue?: OfflineQueue
    private queueSync?: QueueSynchronizer
    private syncOfflineQueue?: SyncOfflineQueue
    private maxRetries: number
    private syncHub?: SyncHub

    private cursorStorage = createSyncCursorStorage({
        baseKey: `atoma:sync:${this.config.baseURL}`,
        cursorKey: this.config.sync?.cursorKey,
        deviceIdKey: this.config.sync?.deviceIdKey
    })

    constructor(
        private config: HTTPAdapterConfig<T>,
        private deps: {
            queueStorageKey: string
            eventEmitter: HTTPEventEmitter
            client: HTTPClient<T>
            fetchWithRetry: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
            getHeaders: () => Promise<Record<string, string>>
            requestIdSequencer?: RequestIdSequencer
            retry?: RetryConfig
            devtools?: DevtoolsBridge
            onSyncPushResult?: (res: SyncPushResponse, ops: SyncQueuedOperation[]) => Promise<void>
        }
    ) {
        this.maxRetries = deps.retry?.maxAttempts ?? 3

        this.networkState = new NetworkStateManager(
            () => {
                if (this.config.offline?.syncOnReconnect !== false) {
                    void this.handleReconnect()
                }
            },
            () => { }
        )

        const syncEnabled = this.config.sync?.enabled === true

        if (syncEnabled) {
            const storageKey = `${deps.queueStorageKey}:sync`
            this.syncOfflineQueue = new SyncOfflineQueue(
                storageKey,
                {
                    onQueueChange: config.events?.onQueueChange,
                    onQueueFull: (dropped, max) => config.events?.onQueueFull?.(dropped as any, max)
                },
                config.offline?.maxQueueSize ?? 1000
            )

            const queueSnapshot = () => ({
                pending: this.syncOfflineQueue!.snapshot().map(op => ({
                    id: op.idempotencyKey,
                    type: op.kind,
                    retries: (op as any).retryCount ?? 0,
                    payload: {
                        resource: op.resource,
                        id: (op as any).id,
                        baseVersion: (op as any).baseVersion
                    }
                })),
                failed: []
            })
            deps.devtools?.registerQueue?.({
                name: `${config.resourceName || deps.queueStorageKey}:sync`,
                snapshot: queueSnapshot
            }) || registerGlobalQueue({
                name: `${config.resourceName || deps.queueStorageKey}:sync`,
                snapshot: queueSnapshot
            })
        } else {
            this.offlineQueue = new OfflineQueue(
                deps.queueStorageKey,
                {
                    onQueueChange: config.events?.onQueueChange,
                    onQueueFull: (dropped) => config.events?.onQueueFull?.(dropped, config.offline?.maxQueueSize || 1000)
                },
                config.offline?.maxQueueSize
            )
            const queueSnapshot = () => ({
                pending: this.offlineQueue!.snapshot().map(op => ({ ...op, retries: op.retryCount ?? 0 })),
                failed: []
            })
            deps.devtools?.registerQueue?.({
                name: config.resourceName || deps.queueStorageKey,
                snapshot: queueSnapshot
            }) || registerGlobalQueue({
                name: config.resourceName || deps.queueStorageKey,
                snapshot: queueSnapshot
            })

            this.queueSync = new QueueSynchronizer(
                this.offlineQueue,
                deps.eventEmitter,
                async (op) => {
                    if (!op.key) return
                    if (op.type === 'put' && op.value) {
                        await deps.client.put(op.key, op.value)
                    } else if (op.type === 'delete') {
                        await deps.client.delete(op.key)
                    }
                },
                {
                    concurrency: this.config.concurrency?.bulk,
                    maxRetries: this.maxRetries
                }
            )
        }
    }

    setSyncHub(hub: SyncHub | undefined) {
        this.syncHub = hub
    }

    dispose() {
        this.networkState.dispose()
    }

    isNetworkError(error: any): boolean {
        return this.networkState.isNetworkError(error)
    }

    get isOnline() {
        return this.networkState.isOnline
    }

    /**
     * Execute an operation; on offline or network error, enqueue when enabled.
     */
    async handleWithOfflineFallback(
        op: { type: OpKind; key: StoreKey; value?: any },
        action: () => Promise<void>
    ): Promise<void> {
        if (!this.networkState.isOnline && this.config.offline?.enabled) {
            await this.queueOperation(op)
            return
        }

        try {
            await action()
        } catch (error) {
            if (this.isNetworkError(error) && this.config.offline?.enabled) {
                await this.queueOperation(op)
                return
            }
            throw error
        }
    }

    async syncQueue(): Promise<void> {
        if (this.config.sync?.enabled === true) {
            await this.syncSyncQueue()
            return
        }
        await this.queueSync?.sync()
    }

    private async handleReconnect(): Promise<void> {
        if (this.config.sync?.enabled === true) {
            // 先 pull 再 replay：降低 409 冲突概率
            try {
                await this.syncHub?.pullNow()
            } catch {
                // ignore（pull 失败不应阻塞 replay）
            }
            try {
                await this.syncSyncQueue()
            } catch {
                // ignore（网络错误会保留队列，后续 online/poll/SSE 仍可兜底）
            }
            return
        }

        try {
            await this.queueSync?.sync()
        } catch {
            // ignore
        }
    }

    private async queueOperation(op: { type: OpKind; key: StoreKey; value?: any }) {
        if (this.config.sync?.enabled === true) {
            // sync 模式下不使用旧的 put/delete 队列
            return
        }
        const queued: QueuedOperation = {
            id: this.generateOperationId(),
            type: op.type,
            key: op.key,
            value: op.value,
            timestamp: Date.now()
        }
        await this.offlineQueue!.enqueue(queued)
    }

    private generateOperationId(): string {
        if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
            return (crypto as any).randomUUID()
        }
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`
    }

    getPendingEntityKeys(): Set<string> {
        if (this.config.sync?.enabled === true) {
            return this.syncOfflineQueue?.keysWithPending() ?? new Set()
        }
        const out = new Set<string>()
        const snapshot = this.offlineQueue?.snapshot() ?? []
        snapshot.forEach(op => {
            if (op.key === undefined) return
            out.add(`${String(op.key)}`)
        })
        return out
    }

    async pushOrQueueSyncOps(
        ops: SyncQueuedOperation[],
        meta?: { traceId?: string; requestId?: string }
    ): Promise<SyncPushResponse | undefined> {
        if (this.config.sync?.enabled !== true) return undefined
        if (!ops.length) return undefined
        await this.syncOfflineQueue?.waitForReady()

        const offlineEnabled = this.config.offline?.enabled === true

        if (offlineEnabled && !this.networkState.isOnline) {
            await Promise.all(ops.map(op => this.syncOfflineQueue!.enqueue(op)))
            return undefined
        }

        try {
            const res = await this.pushSyncOps(ops, meta)
            return res
        } catch (error) {
            if (offlineEnabled && this.isNetworkError(error)) {
                await Promise.all(ops.map(op => this.syncOfflineQueue!.enqueue(op)))
                return undefined
            }
            throw error
        }
    }

    private async syncSyncQueue(): Promise<void> {
        if (!this.syncOfflineQueue) return
        await this.syncOfflineQueue.waitForReady()
        if (this.syncOfflineQueue.size() === 0) return

        this.deps.eventEmitter.emitSyncStart(this.syncOfflineQueue.size())
        try {
            const snapshot = this.syncOfflineQueue.snapshot()
            const maxOps = 200
            const chunks: SyncQueuedOperation[][] = []
            for (let i = 0; i < snapshot.length; i += maxOps) {
                chunks.push(snapshot.slice(i, i + maxOps))
            }

            const ackedKeys = new Set<string>()
            for (const chunk of chunks) {
                try {
                    const res = await this.pushSyncOps(chunk)
                    try {
                        await this.deps.onSyncPushResult?.(res, chunk)
                    } catch (err) {
                        // 不阻塞队列；写回失败交由订阅/pull 兜底
                        this.deps.eventEmitter.emitSyncError(err as Error, chunk[0] as any)
                    }
                    res.acked.forEach(a => ackedKeys.add(a.idempotencyKey))
                    res.rejected.forEach(r => ackedKeys.add(r.idempotencyKey))
                } catch (error) {
                    if (this.isNetworkError(error)) {
                        // 网络问题：停止同步，保留队列
                        throw error
                    }
                    // 非网络错误：逐条标记为失败并丢弃（避免阻塞队列）
                    chunk.forEach(op => {
                        this.deps.eventEmitter.emitSyncError(error as Error, op as any)
                        ackedKeys.add(op.idempotencyKey)
                    })
                }
            }

            await this.syncOfflineQueue.removeByIdempotencyKeys(ackedKeys)
        } finally {
            this.deps.eventEmitter.emitSyncComplete(this.syncOfflineQueue?.size() ?? 0)
        }
    }

    private async pushSyncOps(
        ops: SyncQueuedOperation[],
        meta?: { traceId?: string; requestId?: string }
    ): Promise<SyncPushResponse> {
        const pushPath = this.config.sync?.endpoints?.push ?? '/sync/push'
        const url = makeUrl(this.config.baseURL, pushPath)
        const headers = await this.deps.getHeaders()

        const deviceId = await this.cursorStorage.getOrCreateDeviceId()

        const traceId = meta?.traceId
        const requestId = meta?.requestId ?? (traceId ? this.deps.requestIdSequencer?.next(traceId) : undefined)
        const traceHeaders = traceId
            ? {
                [TRACE_ID_HEADER]: traceId,
                ...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {})
            }
            : {}

        const body = {
            ...(deviceId ? { deviceId } : {}),
            ...(traceId ? { traceId } : {}),
            ...(requestId ? { requestId } : {}),
            ops: ops.map(op => this.toSyncPushOp(op))
        }

        const res = await this.deps.fetchWithRetry(url, {
            method: 'POST',
            headers: { ...headers, ...traceHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })

        const json = await res.json().catch(() => null)
        if (!res.ok) {
            const msg = (json && typeof json === 'object' && (json as any).error?.message)
                ? String((json as any).error.message)
                : `Sync push failed: ${res.status}`
            const err = new Error(msg)
            ;(err as any).status = res.status
            ;(err as any).body = json
            throw err
        }

        const out = json as SyncPushResponse
        const serverCursor = typeof out?.serverCursor === 'number' ? out.serverCursor : undefined
        if (serverCursor !== undefined) {
            await this.syncHub?.advanceCursor(serverCursor)
        }
        return out
    }

    private toSyncPushOp(op: SyncQueuedOperation): SyncPushOp {
        if (op.kind === 'create') {
            return {
                idempotencyKey: op.idempotencyKey,
                resource: op.resource,
                kind: 'create',
                ...(op.id !== undefined ? { id: op.id } : {}),
                timestamp: op.timestamp,
                data: op.data
            }
        }
        if (op.kind === 'patch') {
            return {
                idempotencyKey: op.idempotencyKey,
                resource: op.resource,
                kind: 'patch',
                id: op.id,
                baseVersion: op.baseVersion,
                timestamp: op.timestamp,
                patches: op.patches as any
            }
        }
        return {
            idempotencyKey: op.idempotencyKey,
            resource: op.resource,
            kind: 'delete',
            id: op.id,
            baseVersion: op.baseVersion,
            timestamp: op.timestamp
        }
    }
}
