import type { FindManyOptions, StoreKey } from '../core/types'
import { createRequestIdSequencer } from '../observability/trace'
import type { RequestIdSequencer } from '../observability/trace'
import type { ObservabilityContext } from '../observability/types'
import { isWriteQueueFull, normalizeMaxBatchSize, normalizeMaxQueueLength, normalizeMaxQueryOpsPerRequest } from './config'
import { drainQueryLane } from './queryLane'
import { sendBatchRequest } from './transport'
import type { Deferred, QueryEnvelope, QueryTask, WriteTask } from './types'
import { bucketKey, drainWriteLane } from './writeLane'
import type { AtomaPatch } from '../protocol/sync'

type FetchFn = typeof fetch

export interface BatchEngineConfig {
    /** Batch endpoint path (default: `/batch`, aligned with atoma/server default batchPath) */
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
     * Max items per bulk op. For the query lane, this is the max query ops per request.
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
    /** Shared requestId sequencer (to share a sequence across query/write lanes). */
    requestIdSequencer?: RequestIdSequencer
    /** Called when a batch request fails (instrumentation/logging hook). */
    onError?: (error: Error, context: any) => void
}

export class BatchEngine {
    /**
     * In-memory batch scheduler.
     *
     * BatchEngine owns two independent "lanes" that share a single transport endpoint:
     * - Query lane: coalesces read/query operations into fewer HTTP requests.
     * - Write lane: coalesces mutations into bucketed bulk operations with fairness.
     *
     * The actual drain algorithms live in `./queryLane` and `./writeLane` as engine-driven functions
     * (`drainQueryLane(engine)` / `drainWriteLane(engine)`).
     *
     * This class intentionally owns scheduling (microtasks/timers), lifecycle (`dispose`), and shared
     * resources (abort controllers). Keeping timers here (instead of inside lane modules) makes the
     * drainers easier to test and keeps "who cancels timers on dispose" unambiguous.
     */
    private disposed = false
    private seq = 0
    private readonly disposedError = new Error('BatchEngine disposed')
    private readonly queueOverflowError = new Error('BatchEngine queue overflow')
    private readonly droppedQueryError = new Error('BatchEngine dropped old query due to queue overflow')

    private readonly endpoint: string
    private readonly fetcher: FetchFn
    private readonly inFlightControllers = new Set<AbortController>()
    private readonly inFlightTasks = new Set<{ deferred: Deferred<any> }>()

    /**
     * Query lane state.
     *
     * Callers: adapters enqueue query tasks via `enqueueQuery`, which triggers `signalQueryLane()`.
     * Drain: `runQueryLane()` delegates to `drainQueryLane(this)`.
     *
     * Scheduling:
     * - `queryScheduled/queryTimer` implement coalesced flushing (microtask by default, optional delay via `flushIntervalMs`)
     * - `queryInFlight` enforces `queryMaxInFlight`
     */
    private queryQueue: Array<QueryTask<any>> = []
    private queryScheduled = false
    private queryTimer?: ReturnType<typeof setTimeout>
    private queryInFlight = 0

    /**
     * Write lane state (bucketed).
     *
     * Writes are bucketed by `{action}:{resource}` to build stable bulk ops and provide fairness
     * (round-robin across buckets). Callers enqueue write tasks via `enqueue*`, which triggers
     * `signalWriteLane()`. Drain: `runWriteLane()` delegates to `drainWriteLane(this)`.
     */
    private writeBuckets = new Map<string, WriteTask[]>()
    private writeReady: string[] = []
    private writeReadySet = new Set<string>()
    private writeScheduled = false
    private writeTimer?: ReturnType<typeof setTimeout>
    private writeInFlight = 0
    private writePendingCount = 0
    private readonly requestIdSequencer: RequestIdSequencer

    constructor(private readonly config: BatchEngineConfig = {}) {
        this.endpoint = (config.endpoint || '/batch').replace(/\/$/, '')
        this.fetcher = config.fetchFn ?? fetch
        this.requestIdSequencer = config.requestIdSequencer ?? createRequestIdSequencer()
    }

    /**
     * Enqueue a query task to be batched.
     *
     * Where it's called:
     * - Adapters (e.g. HTTP adapter) call this when batch mode is enabled.
     *
     * How it's designed:
     * - Backpressure is applied per-lane via `maxQueueLength` and `queryOverflowStrategy`.
     * - Observability context is passed explicitly via `internalContext` (traceId/emitter).
     * - The lane is scheduled via `signalQueryLane()` (microtask/timer coalescing).
     */
    enqueueQuery<T>(
        resource: string,
        params: FindManyOptions<T> | undefined,
        fallback: () => Promise<any>,
        internalContext?: ObservabilityContext
    ): Promise<QueryEnvelope<T>> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }

            const maxLen = normalizeMaxQueueLength(this.config, 'query')
            if (maxLen !== Infinity) {
                const strategy = this.config.queryOverflowStrategy ?? 'reject_new'
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

            const opId = this.nextOpId('q')
            this.queryQueue.push({
                kind: 'query',
                opId,
                resource,
                params,
                ctx: internalContext,
                fallback,
                deferred: { resolve, reject }
            })

            this.signalQueryLane()
        })
    }

    /**
     * Enqueue write tasks to be batched.
     *
     * Where it's called:
     * - Adapters enqueue mutations (create/update/patch/delete).
     *
     * How it's designed:
     * - Backpressure uses `writePendingCount` (across all buckets) and `isWriteQueueFull`.
     * - Tasks are bucketed by `bucketKey(task)` to build bulk ops and avoid starvation.
     * - The lane is scheduled via `signalWriteLane()`.
     */
    enqueueCreate<T>(resource: string, item: T, internalContext?: ObservabilityContext): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.config, this.writePendingCount)) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({
                kind: 'create',
                resource,
                item,
                idempotencyKey: this.createIdempotencyKey(),
                deferred: { resolve, reject },
                ctx: internalContext
            })
        })
    }

    enqueueUpdate<T>(
        resource: string,
        item: { id: StoreKey; data: T; baseVersion: number; meta?: { idempotencyKey?: string } },
        internalContext?: ObservabilityContext
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.config, this.writePendingCount)) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({
                kind: 'update',
                resource,
                item: {
                    ...item,
                    meta: {
                        ...(item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta) ? item.meta : {}),
                        idempotencyKey: (typeof item.meta?.idempotencyKey === 'string' && item.meta.idempotencyKey)
                            ? item.meta.idempotencyKey
                            : this.createIdempotencyKey()
                    }
                },
                deferred: { resolve, reject },
                ctx: internalContext
            })
        })
    }

    enqueuePatch(
        resource: string,
        item: { id: StoreKey; patches: AtomaPatch[]; baseVersion: number; timestamp?: number; meta?: { idempotencyKey?: string } },
        internalContext?: ObservabilityContext
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.config, this.writePendingCount)) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({
                kind: 'patch',
                resource,
                item: {
                    ...item,
                    meta: {
                        ...(item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta) ? item.meta : {}),
                        idempotencyKey: (typeof item.meta?.idempotencyKey === 'string' && item.meta.idempotencyKey)
                            ? item.meta.idempotencyKey
                            : this.createIdempotencyKey()
                    }
                },
                deferred: { resolve, reject },
                ctx: internalContext
            })
        })
    }

    enqueueDelete(resource: string, item: { id: StoreKey; baseVersion: number; meta?: { idempotencyKey?: string } }, internalContext?: ObservabilityContext): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.config, this.writePendingCount)) {
                reject(this.queueOverflowError)
                return
            }
            this.pushWriteTask({
                kind: 'delete',
                resource,
                item: {
                    ...item,
                    meta: {
                        ...(item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta) ? item.meta : {}),
                        idempotencyKey: (typeof item.meta?.idempotencyKey === 'string' && item.meta.idempotencyKey)
                            ? item.meta.idempotencyKey
                            : this.createIdempotencyKey()
                    }
                },
                deferred: { resolve, reject },
                ctx: internalContext
            })
        })
    }

    dispose() {
        this.disposed = true

        this.queryScheduled = false
        if (this.queryTimer) {
            clearTimeout(this.queryTimer)
            this.queryTimer = undefined
        }

        this.writeScheduled = false
        if (this.writeTimer) {
            clearTimeout(this.writeTimer)
            this.writeTimer = undefined
        }

        // best-effort abort in-flight requests
        for (const controller of this.inFlightControllers.values()) {
            try {
                controller.abort()
            } catch {
                // ignore
            }
        }
        this.inFlightControllers.clear()

        const pendingQueries = this.queryQueue.splice(0, this.queryQueue.length)
        pendingQueries.forEach(t => t.deferred.reject(this.disposedError))

        for (const tasks of this.writeBuckets.values()) {
            tasks.forEach(t => t.deferred.reject(this.disposedError))
        }
        this.writeBuckets.clear()
        this.writeReady = []
        this.writeReadySet.clear()
        this.writePendingCount = 0

        // reject tasks that were already dequeued into an in-flight request
        for (const task of this.inFlightTasks.values()) {
            task.deferred.reject(this.disposedError)
        }
        this.inFlightTasks.clear()
    }

    private pushWriteTask(task: WriteTask) {
        const key = bucketKey(task)
        const list = this.writeBuckets.get(key) ?? []
        list.push(task)
        this.writeBuckets.set(key, list)
        this.writePendingCount++

        if (!this.writeReadySet.has(key)) {
            this.writeReady.push(key)
            this.writeReadySet.add(key)
        }

        this.signalWriteLane()
    }

    private createIdempotencyKey(): string {
        if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
            return `b_${(crypto as any).randomUUID()}`
        }
        this.seq += 1
        return `b_${Date.now()}_${this.seq}`
    }

    /**
     * Schedule a query-lane drain.
     *
     * We flush immediately when `queryQueue` reaches the per-request op cap, otherwise we coalesce:
     * - `flushIntervalMs === 0`: microtask flush (same tick)
     * - `flushIntervalMs > 0`: timer-based batching
     */
    private signalQueryLane() {
        if (this.disposed) return

        const max = normalizeMaxQueryOpsPerRequest(this.config)
        if (max !== Infinity && this.queryQueue.length >= max) {
            this.scheduleQueryRun(true)
            return
        }
        this.scheduleQueryRun(false)
    }

    /**
     * Schedule a write-lane drain.
     *
     * We flush immediately when any bucket reaches `maxBatchSize`, otherwise we coalesce
     * using the same microtask/timer strategy as the query lane.
     */
    private signalWriteLane() {
        if (this.disposed) return

        const max = normalizeMaxBatchSize(this.config)
        // If any bucket reaches maxBatchSize, try to flush immediately.
        if (max !== Infinity) {
            for (const tasks of this.writeBuckets.values()) {
                if (tasks.length >= max) {
                    this.scheduleWriteRun(true)
                    return
                }
            }
        }
        this.scheduleWriteRun(false)
    }

    /**
     * Implements the coalesced-flush pattern for query lane.
     *
     * - Only one scheduled run at a time (`queryScheduled`)
     * - If a timer is pending and we need to flush immediately, we cancel the timer and flush in a microtask
     */
    private scheduleQueryRun(immediate: boolean) {
        if (this.queryScheduled) {
            // If we were waiting on a timer (flushIntervalMs > 0) and a threshold is reached,
            // upgrade to an immediate flush by cancelling the timer.
            if (immediate && this.queryTimer) {
                clearTimeout(this.queryTimer)
                this.queryTimer = undefined
                queueMicrotask(() => this.runQueryLane())
            }
            return
        }
        this.queryScheduled = true

        const delay = this.config.flushIntervalMs ?? 0
        if (!immediate && delay > 0) {
            this.queryTimer = setTimeout(() => this.runQueryLane(), delay)
            return
        }
        queueMicrotask(() => this.runQueryLane())
    }

    /**
     * Implements the coalesced-flush pattern for write lane (independent from query lane).
     */
    private scheduleWriteRun(immediate: boolean) {
        if (this.writeScheduled) {
            // If we were waiting on a timer (flushIntervalMs > 0) and a threshold is reached,
            // upgrade to an immediate flush by cancelling the timer.
            if (immediate && this.writeTimer) {
                clearTimeout(this.writeTimer)
                this.writeTimer = undefined
                queueMicrotask(() => this.runWriteLane())
            }
            return
        }
        this.writeScheduled = true

        const delay = this.config.flushIntervalMs ?? 0
        if (!immediate && delay > 0) {
            this.writeTimer = setTimeout(() => this.runWriteLane(), delay)
            return
        }
        queueMicrotask(() => this.runWriteLane())
    }

    /**
     * Drains the query lane.
     *
     * Called only by the scheduler (microtask/timer). Clears scheduling state and delegates
     * the actual drain algorithm to `drainQueryLane`.
     */
    private runQueryLane() {
        this.queryScheduled = false
        if (this.queryTimer) {
            clearTimeout(this.queryTimer)
            this.queryTimer = undefined
        }
        if (this.disposed) return
        void drainQueryLane(this as any)
    }

    /**
     * Drains the write lane.
     *
     * Called only by the scheduler (microtask/timer). Clears scheduling state and delegates
     * the actual drain algorithm to `drainWriteLane`.
     */
    private runWriteLane() {
        this.writeScheduled = false
        if (this.writeTimer) {
            clearTimeout(this.writeTimer)
            this.writeTimer = undefined
        }
        if (this.disposed) return
        void drainWriteLane(this as any)
    }

    private async send(payload: any, signal?: AbortSignal, extraHeaders?: Record<string, string>) {
        return await sendBatchRequest(this.fetcher, this.endpoint, this.config.headers, payload, signal, extraHeaders)
    }

    private nextOpId(prefix: 'q' | 'w') {
        return `${prefix}_${Date.now()}_${this.seq++}`
    }

    private nextRequestId(traceId: string) {
        return this.requestIdSequencer.next(traceId)
    }
}
