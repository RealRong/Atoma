import { Protocol } from '#protocol'
import {
    buildQueryLaneRequestContext,
    clampInt,
    createCoalescedScheduler,
    createAbortController,
    normalizeMaxQueueLength,
    normalizeMaxQueryOpsPerRequest,
    normalizeQueryEnvelope,
    normalizeQueryFallback,
    sendBatchWithAdapterEvents,
    toError
} from './internal'
import { normalizeAtomaServerQueryParams } from './queryParams'
import type { BatchOp, BatchRequest } from '#protocol'
import type { FindManyOptions } from '../core/types'
import type { ObservabilityContext } from '#observability'
import type { QueryEnvelope, QueryTask } from './types'

type SendFn = (payload: BatchRequest, signal?: AbortSignal, extraHeaders?: Record<string, string>) => Promise<{ json: unknown; status: number }>

type QueryLaneDeps = {
    endpoint: () => string
    config: () => {
        flushIntervalMs?: number
        queryMaxInFlight?: number
        maxQueueLength?: number | { query?: number; write?: number }
        queryOverflowStrategy?: 'reject_new' | 'drop_old_queries'
        maxBatchSize?: number
        maxOpsPerRequest?: number
        onError?: (error: Error, context: unknown) => void
    }
    send: SendFn
    nextOpId: (prefix: 'q' | 'w') => string
}

export class QueryLane {
    private disposed = false
    private readonly disposedError = new Error('BatchEngine disposed')
    private readonly queueOverflowError = new Error('BatchEngine queue overflow')
    private readonly droppedQueryError = new Error('BatchEngine dropped old query due to queue overflow')

    private readonly queryQueue: Array<QueryTask<any>> = []
    private queryInFlight = 0
    private readonly inFlightControllers = new Set<AbortController>()
    private readonly inFlightTasks = new Set<QueryTask<any>>()

    private readonly scheduler: ReturnType<typeof createCoalescedScheduler>

    constructor(private readonly deps: QueryLaneDeps) {
        this.scheduler = createCoalescedScheduler({
            getDelayMs: () => this.deps.config().flushIntervalMs ?? 0,
            run: () => this.drain()
        })
    }

    enqueue<T>(
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

            const opId = this.deps.nextOpId('q')
            this.queryQueue.push({
                kind: 'query',
                opId,
                resource,
                params,
                ctx: internalContext,
                fallback,
                deferred: { resolve, reject }
            })

            this.signal()
        })
    }

    async drain() {
        const config = this.deps.config()
        const maxInFlight = clampInt(config.queryMaxInFlight ?? 2, 1, 64)
        const maxOps = normalizeMaxQueryOpsPerRequest(config)

        while (!this.disposed && this.queryInFlight < maxInFlight && this.queryQueue.length) {
            const batch = takeQueryBatch(this.queryQueue, maxOps)

            this.queryInFlight++
            batch.forEach(t => this.inFlightTasks.add(t))
            const controller = createAbortController()
            if (controller) this.inFlightControllers.add(controller)

            const requestContext = buildQueryLaneRequestContext(batch)
            const ctxTargets = requestContext.ctxTargets

            try {
                const ops: BatchOp[] = batch.map(t => {
                    return Protocol.batch.compose.op.query({
                        opId: t.opId,
                        resource: t.resource,
                        params: normalizeAtomaServerQueryParams(t.params)
                    })
                })
                const payload: BatchRequest = Protocol.batch.compose.request({
                    ops,
                    traceId: requestContext.commonTraceId,
                    requestId: requestContext.requestId
                })
                const response = await sendBatchWithAdapterEvents({
                    lane: 'query',
                    endpoint: this.deps.endpoint(),
                    payload,
                    send: this.deps.send,
                    controller,
                    ctxTargets,
                    totalOpCount: batch.length,
                    mixedTrace: requestContext.mixedTrace
                })
                const resultMap = response.resultMap

                for (const task of batch) {
                    if (this.disposed) {
                        task.deferred.reject(this.disposedError)
                        continue
                    }
                    const res = resultMap.get(task.opId)
                    if (!res || res.ok === false || res.error) {
                        await runQueryFallback(task, res?.error, () => this.disposed, this.disposedError)
                        continue
                    }
                    task.deferred.resolve(normalizeQueryEnvelope(res))
                }
            } catch (error: unknown) {
                this.deps.config().onError?.(toError(error), { lane: 'query' })
                for (const task of batch) {
                    if (this.disposed) {
                        task.deferred.reject(this.disposedError)
                        continue
                    }
                    await runQueryFallback(task, error, () => this.disposed, this.disposedError)
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
        const max = normalizeMaxQueryOpsPerRequest(this.deps.config())
        const immediate = max !== Infinity && this.queryQueue.length >= max
        this.scheduler.schedule(immediate)
    }
}

function takeQueryBatch(queue: Array<QueryTask<any>>, maxOps: number) {
    const max = maxOps === Infinity ? Infinity : Math.max(1, Math.floor(maxOps))
    const firstKey = typeof queue[0]?.ctx?.traceId === 'string' && queue[0].ctx.traceId ? queue[0].ctx.traceId : undefined
    let takeCount = 0
    for (let i = 0; i < queue.length && takeCount < max; i++) {
        const task = queue[i]
        const key = typeof task.ctx?.traceId === 'string' && task.ctx.traceId ? task.ctx.traceId : undefined
        if (key !== firstKey) break
        takeCount++
    }
    return queue.splice(0, takeCount)
}

async function runQueryFallback<T>(task: QueryTask<T>, reason: unknown, isDisposed: () => boolean, disposedError: Error) {
    if (isDisposed()) {
        task.deferred.reject(disposedError)
        return
    }
    try {
        const res = await task.fallback()
        task.deferred.resolve(normalizeQueryFallback(res))
    } catch (fallbackError) {
        task.deferred.reject(fallbackError ?? reason)
    }
}
