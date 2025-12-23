import {
    buildOpsLaneRequestContext,
    clampInt,
    createCoalescedScheduler,
    createAbortController,
    isWriteQueueFull,
    normalizeMaxOpsPerRequest,
    sendOpsWithAdapterEvents,
    toError
} from './internal'
import type { ObservabilityContext } from '#observability'
import type { OperationResult, WriteOp } from '#protocol'
import type { OpsTask } from './types'
import type { OpsRequest } from './internal'

type SendFn = (payload: OpsRequest, signal?: AbortSignal, extraHeaders?: Record<string, string>) => Promise<{ json: unknown; status: number }>

type WriteLaneDeps = {
    endpoint: () => string
    config: () => {
        flushIntervalMs?: number
        writeMaxInFlight?: number
        maxQueueLength?: number | { query?: number; write?: number }
        maxOpsPerRequest?: number
        onError?: (error: Error, context: unknown) => void
    }
    send: SendFn
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

            const requestContext = buildOpsLaneRequestContext(batch)
            const ctxTargets = requestContext.ctxTargets

            try {
                const payload: OpsRequest = {
                    meta: {
                        v: 1,
                        ...(requestContext.commonTraceId ? { traceId: requestContext.commonTraceId } : {}),
                        ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
                        clientTimeMs: Date.now()
                    },
                    ops: batch.map(t => t.op)
                }
                const response = await sendOpsWithAdapterEvents({
                    lane: 'write',
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
                    const res = resultMap.get(task.op.opId) ?? missingResult(task.op.opId)
                    task.deferred.resolve(res)
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
        this.scheduler.schedule(false)
    }
}

function takeBatch(queue: OpsTask[], maxOps: number) {
    const takeCount = Math.min(queue.length, maxOps)
    return queue.splice(0, takeCount)
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
