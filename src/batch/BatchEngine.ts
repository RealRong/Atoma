import type { ObservabilityContext } from '#observability'
import type { OpsRequest } from './internal'
import { sendBatchRequest } from './internal'
import { QueryLane } from './queryLane'
import { WriteLane } from './writeLane'
import type { Operation, OperationResult, WriteItem, WriteOp } from '#protocol'
import { Protocol } from '#protocol'

type FetchFn = typeof fetch

export interface BatchEngineConfig {
    /** Ops endpoint path (default: `/ops`, aligned with atoma/server default opsPath) */
    endpoint?: string
    /** Custom headers (can be async, e.g. for tokens) */
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    /** Custom fetch implementation (polyfills, timeouts, instrumentation) */
    fetchFn?: FetchFn
    /**
     * Per-lane queue backpressure limit.
     * - number: applies to both query and write lanes
     * - object: configure query/write separately
     * Default: unlimited.
     */
    maxQueueLength?: number | { query?: number; write?: number }
    /**
     * Query-lane overflow strategy when `maxQueueLength` is exceeded:
     * - `reject_new` (default): reject new enqueues
     * - `drop_old_queries`: drop the oldest queued queries (rejecting their promises) and accept new ones
     */
    queryOverflowStrategy?: 'reject_new' | 'drop_old_queries'
    /**
     * Max items per write op (validation only).
     * Default: unlimited.
     */
    maxBatchSize?: number
    /** Additional delay before flushing (ms). Default: 0 (coalesce within the same tick). */
    flushIntervalMs?: number
    /** Query-lane max concurrent in-flight requests. Default: 2. */
    queryMaxInFlight?: number
    /** Write-lane max concurrent in-flight requests. Default: 1. */
    writeMaxInFlight?: number
    /**
     * Max ops per HTTP request (shared by query/write lanes).
     * Default: unlimited (still bounded by `maxBatchSize` for writes).
     */
    maxOpsPerRequest?: number
    /** Called when a batch request fails (instrumentation/logging hook). */
    onError?: (error: Error, context: any) => void
}

export class BatchEngine {
    /**
     * In-memory batch scheduler.
     *
     * BatchEngine owns two independent lanes that share a single transport endpoint:
     * - Query lane: coalesces read/query operations into fewer HTTP requests.
     * - Write lane: batches WriteOp requests.
     *
     * This class intentionally owns:
     * - scheduling (microtasks/timers)
     * - lifecycle (`dispose`)
     * - shared transport (`send`)
     *
     * Lane state + drain algorithms live inside `QueryLane` / `WriteLane`.
     */
    private readonly endpoint: string
    private readonly fetcher: FetchFn

    private readonly queryLane: QueryLane
    private readonly writeLane: WriteLane

    constructor(private readonly config: BatchEngineConfig = {}) {
        this.endpoint = (config.endpoint || '/ops').replace(/\/$/, '')
        this.fetcher = config.fetchFn ?? fetch

        this.queryLane = new QueryLane({
            endpoint: () => this.endpoint,
            config: () => this.config,
            send: (payload, signal, extraHeaders) => this.send(payload, signal, extraHeaders)
        })

        this.writeLane = new WriteLane({
            endpoint: () => this.endpoint,
            config: () => this.config,
            send: (payload, signal, extraHeaders) => this.send(payload, signal, extraHeaders)
        })
    }

    enqueueOp(
        op: Operation,
        internalContext?: ObservabilityContext
    ): Promise<OperationResult> {
        if (!op || typeof op !== 'object' || typeof (op as any).opId !== 'string' || !(op as any).opId) {
            return Promise.reject(new Error('[BatchEngine] opId is required'))
        }
        if (op.kind === 'query') {
            return this.queryLane.enqueue(op, internalContext)
        }
        if (op.kind === 'write') {
            const normalized = this.ensureWriteItemMeta(op as WriteOp)
            this.validateWriteBatchSize(normalized)
            return this.writeLane.enqueue(normalized, internalContext)
        }
        return Promise.reject(new Error(`[BatchEngine] Unsupported op kind: ${op.kind}`))
    }

    async enqueueOps(
        ops: Operation[],
        internalContext?: ObservabilityContext
    ): Promise<OperationResult[]> {
        return Promise.all(ops.map(op => this.enqueueOp(op, internalContext)))
    }

    dispose() {
        this.queryLane.dispose()
        this.writeLane.dispose()
    }

    private async send(payload: OpsRequest, signal?: AbortSignal, extraHeaders?: Record<string, string>) {
        return await sendBatchRequest(this.fetcher, this.endpoint, this.config.headers, payload, signal, extraHeaders)
    }


    private validateWriteBatchSize(op: WriteOp) {
        const max = this.config.maxBatchSize
        if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return
        const count = Array.isArray(op.write.items) ? op.write.items.length : 0
        if (count > max) {
            throw new Error(`[BatchEngine] write.items exceeds maxBatchSize (${count} > ${max})`)
        }
    }

    private ensureWriteItemMeta(op: WriteOp): WriteOp {
        const items = Array.isArray(op.write.items) ? op.write.items : []
        const nextItems: WriteItem[] = items.map(item => {
            if (!item || typeof item !== 'object') return item as WriteItem
            const meta = (item as any).meta
            const baseMeta = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : {}
            const idempotencyKey = (typeof (baseMeta as any).idempotencyKey === 'string' && (baseMeta as any).idempotencyKey)
                ? (baseMeta as any).idempotencyKey
                : Protocol.ids.createIdempotencyKey()
            return {
                ...(item as any),
                meta: {
                    ...baseMeta,
                    idempotencyKey
                }
            } as WriteItem
        })

        return {
            ...op,
            write: {
                ...op.write,
                items: nextItems
            }
        } as WriteOp
    }

}
