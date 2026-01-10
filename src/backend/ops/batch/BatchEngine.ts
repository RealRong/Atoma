import type { ObservabilityContext } from '#observability'
import type { OpsClient } from '../OpsClient'
import { QueryLane } from './queryLane'
import { WriteLane } from './writeLane'
import { Protocol } from '#protocol'
import type { Operation, OperationResult, WriteOp } from '#protocol'

export interface BatchEngineConfig {
    /** Ops endpoint (for observability payloads only). */
    endpoint?: string
    /** Execute an ops request (transport owned by the adapter). */
    opsClient: OpsClient
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
     * - lifecycle (`dispose`)
     * - shared transport (`opsClient`)
     *
     * Lane state + drain algorithms live inside `QueryLane` / `WriteLane`.
     */
    private readonly endpoint: string
    private readonly opsClient: OpsClient

    private readonly queryLane: QueryLane
    private readonly writeLane: WriteLane

    constructor(private readonly config: BatchEngineConfig) {
        const opsClient = (config as any)?.opsClient
        if (!opsClient || typeof opsClient.executeOps !== 'function') {
            throw new Error('[BatchEngine] config.opsClient is required')
        }
        this.endpoint = (config.endpoint || Protocol.http.paths.OPS).replace(/\/$/, '')
        this.opsClient = config.opsClient

        this.queryLane = new QueryLane({
            endpoint: () => this.endpoint,
            config: () => this.config,
            opsClient: this.opsClient
        })

        this.writeLane = new WriteLane({
            endpoint: () => this.endpoint,
            config: () => this.config,
            opsClient: this.opsClient
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
            const writeOp = op as WriteOp
            this.validateWriteBatchSize(writeOp)
            return this.writeLane.enqueue(writeOp, internalContext)
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

    private validateWriteBatchSize(op: WriteOp) {
        const max = this.config.maxBatchSize
        if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return
        const count = Array.isArray(op.write.items) ? op.write.items.length : 0
        if (count > max) {
            throw new Error(`[BatchEngine] write.items exceeds maxBatchSize (${count} > ${max})`)
        }
    }

}
