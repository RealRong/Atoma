import { Protocol } from '#protocol'
import {
    buildWriteLaneRequestContext,
    clampInt,
    createCoalescedScheduler,
    createAbortController,
    isWriteQueueFull,
    normalizeMaxBatchSize,
    normalizeMaxOpsPerRequest,
    sendBatchWithAdapterEvents,
    toError
} from './internal'
import type { Action, BatchOp, BatchRequest, BulkCreateItem, BulkDeleteItem, BulkPatchItem, BulkUpdateItem } from '#protocol'
import type { StoreKey } from '../core/types'
import type { ObservabilityContext } from '#observability'
import type { AtomaPatch } from '#protocol'
import type { WriteTask } from './types'

type SendFn = (payload: BatchRequest, signal?: AbortSignal, extraHeaders?: Record<string, string>) => Promise<{ json: unknown; status: number }>

type WriteLaneDeps = {
    endpoint: () => string
    config: () => {
        flushIntervalMs?: number
        writeMaxInFlight?: number
        maxQueueLength?: number | { query?: number; write?: number }
        maxBatchSize?: number
        maxOpsPerRequest?: number
        onError?: (error: Error, context: unknown) => void
    }
    send: SendFn
    nextOpId: (prefix: 'q' | 'w') => string
}

export class WriteLane {
    private disposed = false
    private readonly disposedError = new Error('BatchEngine disposed')
    private readonly queueOverflowError = new Error('BatchEngine queue overflow')

    private seq = 0

    private readonly writeBuckets = new Map<string, WriteTask[]>()
    private readonly writeReady: string[] = []
    private readonly writeReadySet = new Set<string>()
    private writeInFlight = 0
    private writePendingCount = 0

    private readonly inFlightControllers = new Set<AbortController>()
    private readonly inFlightTasks = new Set<WriteTask>()

    private readonly scheduler: ReturnType<typeof createCoalescedScheduler>

    constructor(private readonly deps: WriteLaneDeps) {
        this.scheduler = createCoalescedScheduler({
            getDelayMs: () => this.deps.config().flushIntervalMs ?? 0,
            run: () => this.drain()
        })
    }

    enqueueCreate<T>(resource: string, item: T, internalContext?: ObservabilityContext): Promise<any> {
        return this.enqueueWriteTask<any>(({ resolve, reject }) => ({
                kind: 'create',
                resource,
                item,
                idempotencyKey: this.createIdempotencyKey(),
                deferred: { resolve: value => resolve(value), reject },
                ctx: internalContext
            }))
    }

    enqueueUpdate<T>(
        resource: string,
        item: { id: StoreKey; data: T; baseVersion: number; meta?: { idempotencyKey?: string } },
        internalContext?: ObservabilityContext
    ): Promise<void> {
        return this.enqueueWriteTask<void>(({ resolve, reject }) => ({
                kind: 'update',
                resource,
                item: this.withIdempotencyKey(item),
                deferred: { resolve: () => resolve(), reject },
                ctx: internalContext
            }))
    }

    enqueuePatch(
        resource: string,
        item: { id: StoreKey; patches: AtomaPatch[]; baseVersion: number; timestamp?: number; meta?: { idempotencyKey?: string } },
        internalContext?: ObservabilityContext
    ): Promise<void> {
        return this.enqueueWriteTask<void>(({ resolve, reject }) => ({
                kind: 'patch',
                resource,
                item: this.withIdempotencyKey(item),
                deferred: { resolve: () => resolve(), reject },
                ctx: internalContext
            }))
    }

    enqueueDelete(
        resource: string,
        item: { id: StoreKey; baseVersion: number; meta?: { idempotencyKey?: string } },
        internalContext?: ObservabilityContext
    ): Promise<void> {
        return this.enqueueWriteTask<void>(({ resolve, reject }) => ({
                kind: 'delete',
                resource,
                item: this.withIdempotencyKey(item),
                deferred: { resolve: () => resolve(), reject },
                ctx: internalContext
            }))
    }

    private enqueueWriteTask<T>(build: (deferred: { resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void }) => WriteTask): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (this.disposed) {
                reject(this.disposedError)
                return
            }
            if (isWriteQueueFull(this.deps.config(), this.writePendingCount)) {
                reject(this.queueOverflowError)
                return
            }
            const task = build({ resolve, reject })
            this.pushWriteTask(task)
        })
    }

    private withIdempotencyKey<T extends { meta?: { idempotencyKey?: string } }>(item: T): T {
        const baseMeta = (item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)) ? item.meta : {}
        const idempotencyKey = (typeof item.meta?.idempotencyKey === 'string' && item.meta.idempotencyKey)
            ? item.meta.idempotencyKey
            : this.createIdempotencyKey()

        return {
            ...item,
            meta: {
                ...baseMeta,
                idempotencyKey
            }
        }
    }

    async drain() {
        const config = this.deps.config()
        const maxInFlight = clampInt(config.writeMaxInFlight ?? 1, 1, 64)
        const maxItems = normalizeMaxBatchSize(config)
        const maxOps = normalizeMaxOpsPerRequest(config)

        while (!this.disposed && this.writeInFlight < maxInFlight && this.writeReady.length) {
            const take = this.takeWriteOps(maxOps, maxItems)
            const ops = take.ops
            const slicesByOpId = take.slicesByOpId

            if (!ops.length) break

            const requestContext = buildWriteLaneRequestContext(slicesByOpId)
            const ctxTargets = requestContext.ctxTargets

            this.writeInFlight++
            for (const slice of slicesByOpId.values()) {
                slice.forEach(t => this.inFlightTasks.add(t))
            }
            const controller = createAbortController()
            if (controller) this.inFlightControllers.add(controller)
            try {
                const payload: BatchRequest = Protocol.batch.compose.request({
                    ops,
                    traceId: requestContext.commonTraceId,
                    requestId: requestContext.requestId
                })
                const response = await sendBatchWithAdapterEvents({
                    lane: 'write',
                    endpoint: this.deps.endpoint(),
                    payload,
                    send: this.deps.send,
                    controller,
                    ctxTargets,
                    totalOpCount: ops.length,
                    mixedTrace: requestContext.mixedTrace
                })
                const resultMap = response.resultMap

                for (const [opId, slice] of slicesByOpId.entries()) {
                    if (this.disposed) {
                        slice.forEach(t => t.deferred.reject(this.disposedError))
                        continue
                    }
                    const res = resultMap.get(opId)

                    if (!res || res.ok === false || res.error) {
                        const err = res?.error ?? new Error('Batch write failed')
                        this.deps.config().onError?.(toError(err), { lane: 'write', opId })
                        slice.forEach(t => t.deferred.reject(err))
                        continue
                    }

                    const failures = new Set<number>()
                    for (const f of res.partialFailures ?? []) {
                        failures.add(f.index)
                    }

                    slice.forEach((task, index) => {
                        if (failures.has(index)) {
                            const failure = res.partialFailures?.find(f => f.index === index)
                            task.deferred.reject(failure?.error ?? new Error('Partial failure'))
                            return
                        }

                        const payloadData = Array.isArray(res.data) ? res.data[index] : undefined
                        if (task.kind === 'create') {
                            task.deferred.resolve(payloadData)
                            return
                        }
                        task.deferred.resolve(undefined)
                    })
                }
            } catch (error: unknown) {
                this.deps.config().onError?.(toError(error), { lane: 'write', opCount: ops.length })
                for (const slice of slicesByOpId.values()) {
                    slice.forEach(t => t.deferred.reject(this.disposed ? this.disposedError : error))
                }
            } finally {
                if (controller) this.inFlightControllers.delete(controller)
                for (const slice of slicesByOpId.values()) {
                    slice.forEach(t => this.inFlightTasks.delete(t))
                }
                this.writeInFlight--
            }
        }

        if (!this.disposed && (this.writeReady.length || hasPendingBuckets(this.writeBuckets))) {
            this.signal()
        }
    }

    private takeWriteOps(maxOps: number, maxItems: number) {
        const ops: BatchOp[] = []
        const slicesByOpId = new Map<string, WriteTask[]>()

        while (ops.length < maxOps && this.writeReady.length) {
            const key = this.writeReady.shift()!
            this.writeReadySet.delete(key)

            const tasks = this.writeBuckets.get(key)
            if (!tasks || !tasks.length) {
                this.writeBuckets.delete(key)
                continue
            }

            const slice = tasks.splice(0, maxItems === Infinity ? tasks.length : maxItems)
            this.writePendingCount -= slice.length
            if (!tasks.length) {
                this.writeBuckets.delete(key)
            } else {
                this.writeReady.push(key)
                this.writeReadySet.add(key)
            }

            const opId = this.deps.nextOpId('w')
            const op = buildWriteOp(opId, key, slice)
            if (!op) continue
            ops.push(op)
            slicesByOpId.set(opId, slice)
        }

        return { ops, slicesByOpId }
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

        for (const tasks of this.writeBuckets.values()) {
            tasks.forEach(t => t.deferred.reject(this.disposedError))
        }
        this.writeBuckets.clear()
        this.writeReady.length = 0
        this.writeReadySet.clear()
        this.writePendingCount = 0

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

        this.signal()
    }

    private signal() {
        if (this.disposed) return

        const max = normalizeMaxBatchSize(this.deps.config())
        let immediate = false
        if (max !== Infinity) {
            for (const tasks of this.writeBuckets.values()) {
                if (tasks.length >= max) {
                    immediate = true
                    break
                }
            }
        }

        this.scheduler.schedule(immediate)
    }

    private createIdempotencyKey(): string {
        if (typeof crypto !== 'undefined') {
            const randomUUID = Reflect.get(crypto, 'randomUUID')
            if (typeof randomUUID === 'function') {
                const uuid = randomUUID.call(crypto)
                if (typeof uuid === 'string' && uuid) return `b_${uuid}`
            }
        }
        this.seq += 1
        return `b_${Date.now()}_${this.seq}`
    }
}

function hasPendingBuckets(map: Map<string, WriteTask[]>) {
    for (const tasks of map.values()) {
        if (tasks.length) return true
    }
    return false
}

function bucketKey(task: WriteTask) {
    const action =
        task.kind === 'create' ? 'bulkCreate'
            : task.kind === 'update' ? 'bulkUpdate'
                : task.kind === 'patch' ? 'bulkPatch'
                    : 'bulkDelete'
    return `${action}:${task.resource}`
}

function isWriteAction(value: unknown): value is Exclude<Action, 'query'> {
    return value === 'bulkCreate'
        || value === 'bulkUpdate'
        || value === 'bulkPatch'
        || value === 'bulkDelete'
}

function buildWriteOp(opId: string, key: string, tasks: WriteTask[]): BatchOp | undefined {
    const [rawAction, resource] = key.split(':', 2)
    if (!isWriteAction(rawAction) || !resource) return undefined

    if (rawAction === 'bulkCreate') {
        const payload: BulkCreateItem[] = []
        for (const t of tasks) {
            if (t.kind !== 'create') return undefined
            payload.push({ data: t.item, meta: { idempotencyKey: t.idempotencyKey } })
        }
        return Protocol.batch.compose.op.bulkCreate({ opId, resource, payload })
    }

    if (rawAction === 'bulkUpdate') {
        const payload: BulkUpdateItem[] = []
        for (const t of tasks) {
            if (t.kind !== 'update') return undefined
            payload.push(t.item)
        }
        return Protocol.batch.compose.op.bulkUpdate({ opId, resource, payload })
    }

    if (rawAction === 'bulkPatch') {
        const payload: BulkPatchItem[] = []
        for (const t of tasks) {
            if (t.kind !== 'patch') return undefined
            payload.push(t.item)
        }
        return Protocol.batch.compose.op.bulkPatch({ opId, resource, payload })
    }

    const payload: BulkDeleteItem[] = []
    for (const t of tasks) {
        if (t.kind !== 'delete') return undefined
        payload.push(t.item)
    }
    return Protocol.batch.compose.op.bulkDelete({ opId, resource, payload })
}
