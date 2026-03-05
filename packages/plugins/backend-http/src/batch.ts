import PQueue from 'p-queue'
import { normalizeNonNegativeInt, normalizePositiveInt, toError } from '@atoma-js/shared'
import type { Meta, RemoteOp, RemoteOpResult, WriteOp } from '@atoma-js/types/protocol'
import type { ExecuteOperationsInput, ExecuteOperationsOutput } from '@atoma-js/types/client/ops'

type Deferred<T> = {
    resolve: (value: T) => void
    reject: (reason?: unknown) => void
}

type OperationTask = {
    op: RemoteOp
    meta: Meta
    signal?: AbortSignal
    deferred: Deferred<RemoteOpResult>
}

type LaneKind = 'query' | 'write'

type LaneState = {
    kind: LaneKind
    queue: OperationTask[]
    inFlightTasks: Set<OperationTask>
    controllers: Set<AbortController>
    runner: PQueue
    scheduled: boolean
    timer?: ReturnType<typeof setTimeout>
}

export interface BatchEngineConfig {
    executeFn: (input: ExecuteOperationsInput) => Promise<ExecuteOperationsOutput>
    maxQueueLength?: number | { query?: number; write?: number }
    queryOverflowStrategy?: 'reject_new' | 'drop_old_queries'
    maxBatchSize?: number
    flushIntervalMs?: number
    queryMaxInFlight?: number
    writeMaxInFlight?: number
    maxOpsPerRequest?: number
    onError?: (error: Error, context: { lane: LaneKind }) => void
}

function normalizeLaneQueueLength(args: {
    maxQueueLength: BatchEngineConfig['maxQueueLength']
    sharedMaxQueueLength?: number
    kind: LaneKind
}): number {
    if (typeof args.maxQueueLength === 'number') {
        return args.sharedMaxQueueLength ?? Infinity
    }
    if (args.maxQueueLength && typeof args.maxQueueLength === 'object') {
        const value = args.kind === 'query' ? args.maxQueueLength.query : args.maxQueueLength.write
        return normalizePositiveInt(value) ?? Infinity
    }
    return Infinity
}

function createAbortController(): AbortController | undefined {
    if (typeof AbortController === 'undefined') return undefined
    return new AbortController()
}

function bindAbortSignal(signal: AbortSignal, controller: AbortController): () => void {
    if (signal.aborted) {
        controller.abort()
        return () => {}
    }

    const onAbort = () => {
        controller.abort()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => {
        signal.removeEventListener('abort', onAbort)
    }
}

function mapResults(results: unknown): Map<string, RemoteOpResult> {
    const byOpId = new Map<string, RemoteOpResult>()
    if (!Array.isArray(results)) return byOpId

    results.forEach((value) => {
        if (!value || typeof value !== 'object') return
        const opId = (value as RemoteOpResult).opId
        if (typeof opId !== 'string') return
        byOpId.set(opId, value as RemoteOpResult)
    })

    return byOpId
}

function missingResult(opId: string): RemoteOpResult {
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

function takeBatch(queue: OperationTask[], maxOpsPerRequest: number): OperationTask[] {
    if (!queue.length) return []

    const first = queue[0]
    let count = 1
    while (
        count < queue.length
        && count < maxOpsPerRequest
        && queue[count].meta === first.meta
        && queue[count].signal === first.signal
    ) {
        count += 1
    }
    return queue.splice(0, count)
}

export class BatchEngine {
    private readonly disposedError = new Error('BatchEngine disposed')
    private readonly queueOverflowError = new Error('BatchEngine queue overflow')
    private readonly droppedQueryError = new Error('BatchEngine dropped old query due to queue overflow')

    private readonly executeFn: (input: ExecuteOperationsInput) => Promise<ExecuteOperationsOutput>
    private readonly queryMaxQueueLength: number
    private readonly writeMaxQueueLength: number
    private readonly queryOverflowStrategy: 'reject_new' | 'drop_old_queries'
    private readonly maxBatchSize?: number
    private readonly flushIntervalMs: number
    private readonly maxOpsPerRequest: number
    private readonly onError?: (error: Error, context: { lane: LaneKind }) => void

    private disposed = false
    private readonly lanes: Record<LaneKind, LaneState>

    constructor(config: BatchEngineConfig) {
        if (typeof config.executeFn !== 'function') {
            throw new Error('[BatchEngine] config.executeFn is required')
        }

        this.executeFn = config.executeFn
        const sharedMaxQueueLength = typeof config.maxQueueLength === 'number'
            ? normalizePositiveInt(config.maxQueueLength)
            : undefined
        this.queryMaxQueueLength = normalizeLaneQueueLength({
            maxQueueLength: config.maxQueueLength,
            sharedMaxQueueLength,
            kind: 'query'
        })
        this.writeMaxQueueLength = normalizeLaneQueueLength({
            maxQueueLength: config.maxQueueLength,
            sharedMaxQueueLength,
            kind: 'write'
        })
        this.queryOverflowStrategy = config.queryOverflowStrategy ?? 'reject_new'
        this.maxBatchSize = normalizePositiveInt(config.maxBatchSize)
        this.flushIntervalMs = normalizeNonNegativeInt(config.flushIntervalMs, 0)
        this.maxOpsPerRequest = normalizePositiveInt(config.maxOpsPerRequest) ?? Infinity
        this.onError = typeof config.onError === 'function' ? config.onError : undefined

        this.lanes = {
            query: this.createLane('query', normalizePositiveInt(config.queryMaxInFlight) ?? 2),
            write: this.createLane('write', normalizePositiveInt(config.writeMaxInFlight) ?? 1)
        }
    }

    enqueueOp(args: {
        op: RemoteOp
        meta: Meta
        signal?: AbortSignal
    }): Promise<RemoteOpResult> {
        if (!args.op || typeof args.op !== 'object') {
            return Promise.reject(new Error('[BatchEngine] Invalid op'))
        }

        if (args.op.kind === 'query') {
            return this.enqueueToLane({
                lane: this.lanes.query,
                op: args.op,
                meta: args.meta,
                signal: args.signal,
                maxQueueLength: this.queryMaxQueueLength,
                overflowStrategy: this.queryOverflowStrategy
            })
        }

        if (args.op.kind === 'write') {
            this.validateWriteBatchSize(args.op)
            return this.enqueueToLane({
                lane: this.lanes.write,
                op: args.op,
                meta: args.meta,
                signal: args.signal,
                maxQueueLength: this.writeMaxQueueLength
            })
        }

        return Promise.reject(new Error('[BatchEngine] Unsupported op kind'))
    }

    async enqueueOperations(input: ExecuteOperationsInput): Promise<RemoteOpResult[]> {
        return Promise.all(input.ops.map((op) => this.enqueueOp({
            op,
            meta: input.meta,
            signal: input.signal
        })))
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true

        this.disposeLane(this.lanes.query)
        this.disposeLane(this.lanes.write)
    }

    private createLane(kind: LaneKind, maxInFlight: number): LaneState {
        return {
            kind,
            queue: [],
            inFlightTasks: new Set(),
            controllers: new Set(),
            runner: new PQueue({ concurrency: maxInFlight }),
            scheduled: false
        }
    }

    private enqueueToLane(args: {
        lane: LaneState
        op: RemoteOp
        meta: Meta
        signal?: AbortSignal
        maxQueueLength: number
        overflowStrategy?: 'reject_new' | 'drop_old_queries'
    }): Promise<RemoteOpResult> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }

            const { lane, maxQueueLength, op, meta, signal, overflowStrategy } = args
            if (maxQueueLength !== Infinity && lane.queue.length >= maxQueueLength) {
                if (overflowStrategy === 'drop_old_queries') {
                    while (lane.queue.length >= maxQueueLength) {
                        const dropped = lane.queue.shift()
                        dropped?.deferred.reject(this.droppedQueryError)
                    }
                } else {
                    reject(this.queueOverflowError)
                    return
                }
            }

            lane.queue.push({ op, meta, signal, deferred: { resolve, reject } })
            this.scheduleFlush(lane)
        })
    }

    private scheduleFlush(lane: LaneState): void {
        if (this.disposed || lane.scheduled) return

        lane.scheduled = true

        if (this.flushIntervalMs > 0) {
            lane.timer = setTimeout(() => this.runScheduledFlush(lane), this.flushIntervalMs)
            return
        }

        queueMicrotask(() => this.runScheduledFlush(lane))
    }

    private runScheduledFlush(lane: LaneState): void {
        lane.scheduled = false

        if (lane.timer) {
            clearTimeout(lane.timer)
            lane.timer = undefined
        }

        if (this.disposed) return
        this.flushLane(lane)
    }

    private flushLane(lane: LaneState): void {
        while (!this.disposed && lane.queue.length > 0 && lane.runner.pending < lane.runner.concurrency) {
            const batch = takeBatch(lane.queue, this.maxOpsPerRequest)

            void lane.runner.add(async () => {
                await this.executeBatch(lane, batch)
            }).finally(() => {
                if (!this.disposed && lane.queue.length > 0) {
                    this.scheduleFlush(lane)
                }
            })
        }
    }

    private async executeBatch(lane: LaneState, batch: OperationTask[]): Promise<void> {
        if (this.disposed) {
            batch.forEach((task) => task.deferred.reject(this.disposedError))
            return
        }

        const context = batch[0]
        if (!context) return

        const controller = createAbortController()
        const releaseAbortBinding = controller && context.signal
            ? bindAbortSignal(context.signal, controller)
            : undefined
        if (controller) lane.controllers.add(controller)
        batch.forEach((task) => lane.inFlightTasks.add(task))

        try {
            const output = await this.executeFn({
                ops: batch.map((task) => task.op),
                meta: context.meta,
                signal: controller?.signal ?? context.signal
            })

            const resultMap = mapResults(output.results)
            batch.forEach((task) => {
                if (this.disposed) {
                    task.deferred.reject(this.disposedError)
                    return
                }
                task.deferred.resolve(resultMap.get(task.op.opId) ?? missingResult(task.op.opId))
            })
        } catch (error: unknown) {
            this.onError?.(toError(error), { lane: lane.kind })
            const reason = this.disposed ? this.disposedError : error
            batch.forEach((task) => task.deferred.reject(reason))
        } finally {
            releaseAbortBinding?.()
            if (controller) lane.controllers.delete(controller)
            batch.forEach((task) => lane.inFlightTasks.delete(task))
        }
    }

    private disposeLane(lane: LaneState): void {
        if (lane.timer) {
            clearTimeout(lane.timer)
            lane.timer = undefined
        }
        lane.scheduled = false

        lane.runner.clear()

        lane.controllers.forEach((controller) => {
            try {
                controller.abort()
            } catch {
                // ignore
            }
        })
        lane.controllers.clear()

        lane.queue.splice(0).forEach((task) => task.deferred.reject(this.disposedError))

        lane.inFlightTasks.forEach((task) => task.deferred.reject(this.disposedError))
        lane.inFlightTasks.clear()
    }

    private validateWriteBatchSize(op: WriteOp): void {
        if (!this.maxBatchSize) return

        const count = Array.isArray(op.write.entries) ? op.write.entries.length : 0
        if (count > this.maxBatchSize) {
            throw new Error(`[BatchEngine] write.entries exceeds maxBatchSize (${count} > ${this.maxBatchSize})`)
        }
    }
}
