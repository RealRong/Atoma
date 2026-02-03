import { Protocol } from 'atoma-protocol'
import type { Meta, Operation, OperationResult, QueryOp, WriteOp } from 'atoma-types/protocol'
import type { ExecuteOpsInput, ExecuteOpsOutput } from 'atoma-types/client'
import { zod } from 'atoma-shared'

const { parseOrThrow, z } = zod

type Deferred<T> = {
    resolve: (value: T extends void ? undefined : T) => void
    reject: (reason?: unknown) => void
}

type OpsTask = {
    op: Operation
    deferred: Deferred<OperationResult>
}

type BatchEngineConfigLike = {
    maxQueueLength?: number | { query?: number; write?: number }
    maxBatchSize?: number
    maxOpsPerRequest?: number
}


// ============================================================================
// Utils
// ============================================================================

function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err))
}

function createAbortController() {
    if (typeof AbortController === 'undefined') return undefined
    return new AbortController()
}

function clampInt(v: number, min: number, max: number) {
    if (!Number.isFinite(v)) return min
    const n = Math.floor(v)
    if (n < min) return min
    if (n > max) return max
    return n
}

function normalizePositiveInt(value: unknown) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
}

function createCoalescedScheduler(args: {
    getDelayMs: () => number
    run: () => Promise<void> | void
}) {
    let scheduled = false
    let running = false
    let rerunRequested = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let token = 0

    const trigger = (id: number) => {
        if (disposed) return
        if (id !== token) return
        scheduled = false
        timer = undefined

        running = true
        void Promise.resolve(args.run()).finally(() => {
            running = false
            if (disposed) return
            if (!rerunRequested) return
            rerunRequested = false
            schedule()
        })
    }

    const schedule = () => {
        if (disposed) return
        if (running) {
            rerunRequested = true
            return
        }
        if (scheduled) return
        scheduled = true

        if (timer) {
            clearTimeout(timer)
            timer = undefined
        }

        const delayMs = Math.max(0, Math.floor(args.getDelayMs() ?? 0))
        token += 1
        const id = token

        if (delayMs > 0) {
            timer = setTimeout(() => trigger(id), delayMs)
            return
        }

        queueMicrotask(() => trigger(id))
    }

    const cancel = () => {
        if (timer) {
            clearTimeout(timer)
            timer = undefined
        }
        scheduled = false
        rerunRequested = false
        token += 1
    }

    const dispose = () => {
        disposed = true
        cancel()
    }

    return { schedule, cancel, dispose }
}

// ============================================================================
// Config
// ============================================================================

function normalizeMaxQueueLength(config: BatchEngineConfigLike, lane: 'query' | 'write') {
    const cfg = config.maxQueueLength
    if (typeof cfg === 'number') {
        return normalizePositiveInt(cfg) ?? Infinity
    }
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        const v = lane === 'query' ? cfg.query : cfg.write
        return normalizePositiveInt(v) ?? Infinity
    }
    return Infinity
}

function isWriteQueueFull(config: BatchEngineConfigLike, writePendingCount: number) {
    const maxLen = normalizeMaxQueueLength(config, 'write')
    if (maxLen === Infinity) return false
    return writePendingCount >= maxLen
}

function normalizeMaxOpsPerRequest(config: BatchEngineConfigLike) {
    const n = config.maxOpsPerRequest
    return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? Math.floor(n) : Infinity
}

// ============================================================================
// Ops Batch Execute
// ============================================================================

type OpsRequest = {
    meta: Meta
    ops: Operation[]
}

type OpsResult = OperationResult

function mapOpsResults(results: unknown): Map<string, OpsResult> {
    const map = new Map<string, OpsResult>()
    if (!Array.isArray(results)) return map
    results.forEach((r: any) => {
        if (r && typeof r.opId === 'string') map.set(r.opId, r as OpsResult)
    })
    return map
}

function missingResult(opId: string): OperationResult {
    return {
        opId,
        ok: false,
        error: {
            code: 'INTERNAL',
            message: 'Missing result',
            kind: 'internal'
        }
    }
}

async function executeOpsTasksBatch(args: {
    lane: 'query' | 'write'
    endpoint: string
    tasks: OpsTask[]
    executeFn: (input: { ops: Operation[]; meta: Meta; signal?: AbortSignal }) => Promise<{ results: OperationResult[]; status?: number }>
    controller?: AbortController
}) {
    const payload: OpsRequest = {
        meta: {
            v: 1,
            clientTimeMs: Date.now()
        },
        ops: args.tasks.map(t => t.op)
    }

    try {
        const res = await args.executeFn({
            ops: payload.ops,
            meta: payload.meta,
            signal: args.controller?.signal
        })

        const resultMap = mapOpsResults(res.results)
        return payload.ops.map((op) => resultMap.get(op.opId) ?? missingResult(op.opId))
    } catch (error: unknown) {
        throw error
    }
}

// ============================================================================
// Lanes
// ============================================================================

type QueryLaneDeps = {
    endpoint: () => string
    config: () => {
        flushIntervalMs?: number
        queryMaxInFlight?: number
        maxQueueLength?: number | { query?: number; write?: number }
        queryOverflowStrategy?: 'reject_new' | 'drop_old_queries'
        maxOpsPerRequest?: number
        onError?: (error: Error, context: unknown) => void
    }
    executeFn: (input: ExecuteOpsInput) => Promise<ExecuteOpsOutput>
}

class QueryLane {
    private disposed = false
    private readonly disposedError = new Error('BatchEngine disposed')
    private readonly queueOverflowError = new Error('BatchEngine queue overflow')
    private readonly droppedQueryError = new Error('BatchEngine dropped old query due to queue overflow')

    private readonly queryQueue: Array<OpsTask> = []
    private queryInFlight = 0
    private readonly inFlightControllers = new Set<AbortController>()
    private readonly inFlightTasks = new Set<OpsTask>()

    private readonly scheduler: ReturnType<typeof createCoalescedScheduler>

    constructor(private readonly deps: QueryLaneDeps) {
        this.scheduler = createCoalescedScheduler({
            getDelayMs: () => this.deps.config().flushIntervalMs ?? 0,
            run: () => this.drain()
        })
    }

    enqueue(op: QueryOp): Promise<OperationResult> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }

            const config = this.deps.config()
            const maxLen = normalizeMaxQueueLength(config, 'query')
            if (maxLen !== Infinity) {
                const strategy = config.queryOverflowStrategy ?? 'reject_new'
                if (strategy === 'drop_old_queries') {
                    while (this.queryQueue.length >= maxLen) {
                        const dropped = this.queryQueue.shift()
                        dropped?.deferred.reject(this.droppedQueryError)
                    }
                } else {
                    if (this.queryQueue.length >= maxLen) {
                        reject(this.queueOverflowError)
                        return
                    }
                }
            }

            this.queryQueue.push({
                op,
                deferred: { resolve, reject }
            })

            this.signal()
        })
    }

    async drain() {
        const config = this.deps.config()
        const maxInFlight = clampInt(config.queryMaxInFlight ?? 2, 1, 64)
        const maxOps = normalizeMaxOpsPerRequest(config)

        while (!this.disposed && this.queryInFlight < maxInFlight && this.queryQueue.length) {
            const batch = takeBatch(this.queryQueue, maxOps)

            this.queryInFlight++
            batch.forEach(t => this.inFlightTasks.add(t))
            const controller = createAbortController()
            if (controller) this.inFlightControllers.add(controller)

            try {
                const results = await executeOpsTasksBatch({
                    lane: 'query',
                    endpoint: this.deps.endpoint(),
                    tasks: batch,
                    executeFn: this.deps.executeFn,
                    controller
                })

                for (let i = 0; i < batch.length; i++) {
                    const task = batch[i]
                    if (this.disposed) {
                        task.deferred.reject(this.disposedError)
                        continue
                    }
                    task.deferred.resolve(results[i])
                }
            } catch (error: unknown) {
                this.deps.config().onError?.(toError(error), { lane: 'query' })
                for (const task of batch) {
                    task.deferred.reject(this.disposed ? this.disposedError : error)
                }
            } finally {
                if (controller) this.inFlightControllers.delete(controller)
                batch.forEach(t => this.inFlightTasks.delete(t))
                this.queryInFlight--
            }
        }

        if (!this.disposed && this.queryQueue.length) {
            this.signal()
        }
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.scheduler.dispose()

        for (const controller of this.inFlightControllers.values()) {
            try {
                controller.abort()
            } catch {
                // ignore
            }
        }
        this.inFlightControllers.clear()

        const pending = this.queryQueue.splice(0, this.queryQueue.length)
        pending.forEach(t => t.deferred.reject(this.disposedError))

        for (const task of this.inFlightTasks.values()) {
            task.deferred.reject(this.disposedError)
        }
        this.inFlightTasks.clear()
    }

    private signal() {
        if (this.disposed) return
        this.scheduler.schedule()
    }
}

type WriteLaneDeps = {
    endpoint: () => string
    config: () => {
        flushIntervalMs?: number
        writeMaxInFlight?: number
        maxQueueLength?: number | { query?: number; write?: number }
        maxOpsPerRequest?: number
        onError?: (error: Error, context: unknown) => void
    }
    executeFn: (input: ExecuteOpsInput) => Promise<ExecuteOpsOutput>
}

class WriteLane {
    private disposed = false
    private readonly disposedError = new Error('BatchEngine disposed')
    private readonly queueOverflowError = new Error('BatchEngine queue overflow')

    private readonly writeQueue: Array<OpsTask> = []
    private writeInFlight = 0

    private readonly inFlightControllers = new Set<AbortController>()
    private readonly inFlightTasks = new Set<OpsTask>()

    private readonly scheduler: ReturnType<typeof createCoalescedScheduler>

    constructor(private readonly deps: WriteLaneDeps) {
        this.scheduler = createCoalescedScheduler({
            getDelayMs: () => this.deps.config().flushIntervalMs ?? 0,
            run: () => this.drain()
        })
    }

    enqueue(op: WriteOp): Promise<OperationResult> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.deps.config(), this.writeQueue.length)) {
                reject(this.queueOverflowError)
                return
            }
            this.writeQueue.push({
                op,
                deferred: { resolve, reject }
            })
            this.signal()
        })
    }

    async drain() {
        const config = this.deps.config()
        const maxInFlight = clampInt(config.writeMaxInFlight ?? 1, 1, 64)
        const maxOps = normalizeMaxOpsPerRequest(config)

        while (!this.disposed && this.writeInFlight < maxInFlight && this.writeQueue.length) {
            const batch = takeBatch(this.writeQueue, maxOps)

            this.writeInFlight++
            batch.forEach(t => this.inFlightTasks.add(t))
            const controller = createAbortController()
            if (controller) this.inFlightControllers.add(controller)

            try {
                const results = await executeOpsTasksBatch({
                    lane: 'write',
                    endpoint: this.deps.endpoint(),
                    tasks: batch,
                    executeFn: this.deps.executeFn,
                    controller
                })

                for (let i = 0; i < batch.length; i++) {
                    const task = batch[i]
                    if (this.disposed) {
                        task.deferred.reject(this.disposedError)
                        continue
                    }
                    task.deferred.resolve(results[i])
                }
            } catch (error: unknown) {
                this.deps.config().onError?.(toError(error), { lane: 'write' })
                for (const task of batch) {
                    task.deferred.reject(this.disposed ? this.disposedError : error)
                }
            } finally {
                if (controller) this.inFlightControllers.delete(controller)
                batch.forEach(t => this.inFlightTasks.delete(t))
                this.writeInFlight--
            }
        }

        if (!this.disposed && this.writeQueue.length) {
            this.signal()
        }
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.scheduler.dispose()

        for (const controller of this.inFlightControllers.values()) {
            try {
                controller.abort()
            } catch {
                // ignore
            }
        }
        this.inFlightControllers.clear()

        const pending = this.writeQueue.splice(0, this.writeQueue.length)
        pending.forEach(t => t.deferred.reject(this.disposedError))

        for (const task of this.inFlightTasks.values()) {
            task.deferred.reject(this.disposedError)
        }
        this.inFlightTasks.clear()
    }

    private signal() {
        if (this.disposed) return
        this.scheduler.schedule()
    }
}

function takeBatch(queue: OpsTask[], maxOps: number) {
    const takeCount = Math.min(queue.length, maxOps)
    return queue.splice(0, takeCount)
}

// ============================================================================
// BatchEngine
// ============================================================================

export interface BatchEngineConfig {
    /** Ops endpoint path override. */
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
     * Lane state + drain algorithms are embedded here for locality.
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

    enqueueOp(op: Operation): Promise<OperationResult> {
        if (!op || typeof op !== 'object' || typeof (op as any).opId !== 'string' || !(op as any).opId) {
            return Promise.reject(new Error('[BatchEngine] opId is required'))
        }
        if (op.kind === 'query') {
            return this.queryLane.enqueue(op)
        }
        if (op.kind === 'write') {
            const writeOp = op as WriteOp
            this.validateWriteBatchSize(writeOp)
            return this.writeLane.enqueue(writeOp)
        }
        return Promise.reject(new Error(`[BatchEngine] Unsupported op kind: ${op.kind}`))
    }

    async enqueueOps(ops: Operation[]): Promise<OperationResult[]> {
        return Promise.all(ops.map(op => this.enqueueOp(op)))
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
