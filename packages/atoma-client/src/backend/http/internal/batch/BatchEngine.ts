import type { ObservabilityContext } from 'atoma-observability'
import type { Operation, OperationResult, WriteOp } from 'atoma-protocol'
import type { ExecuteOpsInput, ExecuteOpsOutput } from '../../../types'
import { QueryLane } from './queryLane'
import { WriteLane } from './writeLane'
import { Protocol } from 'atoma-protocol'
import { zod } from 'atoma-shared'

const { parseOrThrow, z } = zod

export interface BatchEngineConfig {
    /** Ops endpoint (for observability payloads only). */
    endpoint?: string
    /** 
     * Direct execution function (no batching).
     * BatchEngine will call this function when flushing batched operations.
     */
    executeFn: (input: ExecuteOpsInput) => Promise<ExecuteOpsOutput>
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
     * - batching logic and flush scheduling
     *
     * Lane state + drain algorithms live inside `QueryLane` / `WriteLane`.
     */
    private readonly endpoint: string
    private readonly executeFn: (input: ExecuteOpsInput) => Promise<ExecuteOpsOutput>

    private readonly queryLane: QueryLane
    private readonly writeLane: WriteLane

    constructor(private readonly config: BatchEngineConfig) {
        const anyFunction = () => z.custom<(...args: any[]) => any>(value => typeof value === 'function')
        this.config = parseOrThrow(
            z.object({
                executeFn: z.any(),
                endpoint: z.string().optional(),
                maxQueueLength: z.union([
                    z.number().finite().int().positive(),
                    z.object({
                        query: z.number().finite().int().positive().optional(),
                        write: z.number().finite().int().positive().optional()
                    }).loose()
                ]).optional(),
                queryOverflowStrategy: z.union([z.literal('reject_new'), z.literal('drop_old_queries')]).optional(),
                maxBatchSize: z.number().finite().int().positive().optional(),
                flushIntervalMs: z.number().finite().nonnegative().optional(),
                queryMaxInFlight: z.number().finite().int().positive().optional(),
                writeMaxInFlight: z.number().finite().int().positive().optional(),
                maxOpsPerRequest: z.number().finite().int().positive().optional(),
                onError: anyFunction().optional()
            })
                .loose()
                .superRefine((value: any, ctx) => {
                    if (typeof value.executeFn !== 'function') {
                        ctx.addIssue({ code: 'custom', message: '[BatchEngine] config.executeFn is required' })
                    }
                }),
            config,
            { prefix: '' }
        ) as any

        this.endpoint = (this.config.endpoint || Protocol.http.paths.OPS).replace(/\/$/, '')
        this.executeFn = this.config.executeFn

        this.queryLane = new QueryLane({
            endpoint: () => this.endpoint,
            config: () => this.config,
            executeFn: this.executeFn
        })

        this.writeLane = new WriteLane({
            endpoint: () => this.endpoint,
            config: () => this.config,
            executeFn: this.executeFn
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
