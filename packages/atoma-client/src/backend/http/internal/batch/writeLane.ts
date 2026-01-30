import {
    clampInt,
    createCoalescedScheduler,
    createAbortController,
    executeOpsTasksBatch,
    isWriteQueueFull,
    normalizeMaxOpsPerRequest,
    toError
} from './internal'
import type { ObservabilityContext } from 'atoma-observability'
import type { ExecuteOpsInput, ExecuteOpsOutput } from '../../../types'
import type { OperationResult, WriteOp } from 'atoma-protocol'
import type { OpsTask } from './types'

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

export class WriteLane {
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

    enqueue(
        op: WriteOp,
        internalContext?: ObservabilityContext
    ): Promise<OperationResult> {
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
                ctx: internalContext,
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
