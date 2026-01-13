import {
    clampInt,
    createCoalescedScheduler,
    createAbortController,
    executeOpsTasksBatch,
    normalizeMaxQueueLength,
    normalizeMaxOpsPerRequest,
    toError
} from './internal'
import type { ObservabilityContext } from '#observability'
import type { ExecuteOpsInput, ExecuteOpsOutput } from '../OpsClient'
import type { OperationResult, QueryOp } from '#protocol'
import type { OpsTask } from './types'

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

export class QueryLane {
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

    enqueue(
        op: QueryOp,
        internalContext?: ObservabilityContext
    ): Promise<OperationResult> {
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
                ctx: internalContext,
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

function takeBatch(queue: OpsTask[], maxOps: number) {
    const takeCount = Math.min(queue.length, maxOps)
    return queue.splice(0, takeCount)
}
