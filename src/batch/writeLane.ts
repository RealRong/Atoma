import type { DebugEmitter } from '../observability/debug'
import { utf8ByteLength } from '../observability/utf8'
import { emitAdapterEvent } from './adapterEvents'
import { normalizeMaxBatchSize, normalizeMaxOpsPerRequest } from './config'
import { mapResults } from './protocol'
import type { Deferred, WriteTask } from './types'
import { clampInt, createAbortController, toError } from './utils'

type SendFn = (payload: any, signal?: AbortSignal, extraHeaders?: Record<string, string>) => Promise<{ json: any; status: number }>

export type WriteLaneEngine = {
    disposed: boolean
    disposedError: Error
    endpoint: string
    config: any
    inFlightControllers: Set<AbortController>
    inFlightTasks: Set<{ deferred: Deferred<any> }>
    writeBuckets: Map<string, WriteTask[]>
    writeReady: string[]
    writeReadySet: Set<string>
    writeInFlight: number
    writePendingCount: number
    send: SendFn
    nextOpId: (prefix: 'q' | 'w') => string
    nextRequestId: (traceId: string) => string
    signalWriteLane: () => void
}

export async function drainWriteLane(engine: WriteLaneEngine) {
    const maxInFlight = clampInt(engine.config.writeMaxInFlight ?? 1, 1, 64)
    const maxItems = normalizeMaxBatchSize(engine.config)
    const maxOps = normalizeMaxOpsPerRequest(engine.config)

    while (!engine.disposed && engine.writeInFlight < maxInFlight && engine.writeReady.length) {
        const ops: any[] = []
        const slicesByOpId = new Map<string, WriteTask[]>()

        while (ops.length < maxOps && engine.writeReady.length) {
            // round-robin：取队首 bucketKey
            const key = engine.writeReady.shift()!
            engine.writeReadySet.delete(key)

            const tasks = engine.writeBuckets.get(key)
            if (!tasks || !tasks.length) {
                engine.writeBuckets.delete(key)
                continue
            }

            // 每次从该 bucket 取一段，最多 maxItems
            const slice = tasks.splice(0, maxItems === Infinity ? tasks.length : maxItems)
            engine.writePendingCount -= slice.length
            if (!tasks.length) {
                engine.writeBuckets.delete(key)
            } else {
                // bucket 仍有剩余，放回队尾保持公平
                engine.writeReady.push(key)
                engine.writeReadySet.add(key)
            }

            const opId = engine.nextOpId('w')
            ops.push(buildWriteOp(opId, key, slice))
            slicesByOpId.set(opId, slice)
        }

        if (!ops.length) break

        const traceState = (() => {
            const distinct = new Set<string>()
            let hasMissing = false
            for (const slice of slicesByOpId.values()) {
                slice.forEach(t => {
                    const id = typeof t.traceId === 'string' && t.traceId ? t.traceId : undefined
                    if (id) distinct.add(id)
                    else hasMissing = true
                })
            }
            const commonTraceId = (!hasMissing && distinct.size === 1) ? Array.from(distinct)[0] : undefined
            const mixedTrace = distinct.size > 1 || (hasMissing && distinct.size > 0)
            return { commonTraceId, mixedTrace }
        })()
        const commonTraceId = traceState.commonTraceId
        const requestId = commonTraceId ? engine.nextRequestId(commonTraceId) : undefined
        const debugEmitters = (() => {
            const byEmitter = new Map<DebugEmitter, { taskCount: number; opIds: Set<string> }>()
            for (const [opId, slice] of slicesByOpId.entries()) {
                slice.forEach(t => {
                    const e = t.debugEmitter
                    if (!e) return
                    const cur = byEmitter.get(e) ?? { taskCount: 0, opIds: new Set<string>() }
                    cur.taskCount++
                    cur.opIds.add(opId)
                    byEmitter.set(e, cur)
                })
            }
            return Array.from(byEmitter.entries()).map(([emitter, meta]) => ({
                emitter,
                taskCount: meta.taskCount,
                opCount: meta.opIds.size
            }))
        })()
        const shouldEmitAdapterEvents = debugEmitters.length > 0

        engine.writeInFlight++
        for (const slice of slicesByOpId.values()) {
            slice.forEach(t => engine.inFlightTasks.add(t as any))
        }
        const controller = createAbortController()
        if (controller) engine.inFlightControllers.add(controller)
        let startedAt: number | undefined
        try {
            const payload = {
                ...(commonTraceId ? { traceId: commonTraceId } : {}),
                ...(requestId ? { requestId } : {}),
                ops
            }
            const payloadBytes = shouldEmitAdapterEvents ? utf8ByteLength(JSON.stringify(payload)) : undefined
            emitAdapterEvent({
                emitters: debugEmitters,
                type: 'adapter:request',
                meta: { requestId },
                payloadFor: ({ opCount, taskCount }) => ({
                    lane: 'write',
                    method: 'POST',
                    endpoint: engine.endpoint,
                    attempt: 1,
                    payloadBytes,
                    opCount,
                    taskCount,
                    totalOpCount: ops.length,
                    mixedTrace: traceState.mixedTrace
                })
            })

            startedAt = Date.now()
            const response = await engine.send(payload, controller?.signal, {
                ...(commonTraceId ? { 'x-atoma-trace-id': commonTraceId } : {}),
                ...(requestId ? { 'x-atoma-request-id': requestId } : {})
            })
            const durationMs = Date.now() - startedAt
            emitAdapterEvent({
                emitters: debugEmitters,
                type: 'adapter:response',
                meta: { requestId },
                payloadFor: ({ opCount, taskCount }) => ({
                    lane: 'write',
                    ok: true,
                    status: response.status,
                    durationMs,
                    opCount,
                    taskCount,
                    totalOpCount: ops.length,
                    mixedTrace: traceState.mixedTrace
                })
            })

            const resultMap = mapResults(response.json?.results)

            for (const [opId, slice] of slicesByOpId.entries()) {
                if (engine.disposed) {
                    slice.forEach(t => t.deferred.reject(engine.disposedError))
                    continue
                }
                const res = resultMap.get(opId)

                if (!res || res.ok === false || res.error) {
                    const err = res?.error ?? new Error('Batch write failed')
                    engine.config.onError?.(toError(err), { lane: 'write', opId })
                    slice.forEach(t => t.deferred.reject(err))
                    continue
                }

                const failures = new Set<number>()
                res.partialFailures?.forEach((f: any) => failures.add(f.index))

                slice.forEach((task, index) => {
                    if (failures.has(index)) {
                        const failure = res.partialFailures?.find((f: any) => f.index === index)
                        task.deferred.reject(failure?.error ?? new Error('Partial failure'))
                        return
                    }

                    const payloadData = Array.isArray(res.data) ? res.data[index] : undefined
                    task.deferred.resolve(payloadData as any)
                })
            }
        } catch (error: any) {
            emitAdapterEvent({
                emitters: debugEmitters,
                type: 'adapter:response',
                meta: { requestId },
                payloadFor: ({ opCount, taskCount }) => ({
                    lane: 'write',
                    ok: false,
                    status: typeof (error as any)?.status === 'number' ? (error as any).status : undefined,
                    durationMs: typeof startedAt === 'number' ? (Date.now() - startedAt) : undefined,
                    opCount,
                    taskCount,
                    totalOpCount: ops.length,
                    mixedTrace: traceState.mixedTrace
                })
            })
            engine.config.onError?.(toError(error), { lane: 'write', opCount: ops.length })
            // request 级失败：对本次已摘出的 items 全部 reject（write 策略不做 fallback）
            for (const slice of slicesByOpId.values()) {
                slice.forEach(t => t.deferred.reject(engine.disposed ? engine.disposedError : error))
            }
        } finally {
            if (controller) engine.inFlightControllers.delete(controller)
            for (const slice of slicesByOpId.values()) {
                slice.forEach(t => engine.inFlightTasks.delete(t as any))
            }
            engine.writeInFlight--
        }
    }

    if (!engine.disposed && (engine.writeReady.length || hasPendingBuckets(engine.writeBuckets))) {
        engine.signalWriteLane()
    }
}

export function bucketKey(task: WriteTask) {
    const action =
        task.kind === 'create' ? 'bulkCreate'
            : task.kind === 'update' ? 'bulkUpdate'
                : task.kind === 'patch' ? 'bulkPatch'
                    : 'bulkDelete'
    return `${action}:${task.resource}`
}

export function buildWriteOp(opId: string, key: string, tasks: WriteTask[]) {
    const [action, resource] = key.split(':', 2)
    const payload = tasks.map(t => {
        if (t.kind === 'create') return t.item
        if (t.kind === 'update') return t.item
        if (t.kind === 'patch') return t.item
        return t.id
    })

    return {
        opId,
        action,
        resource,
        payload
    }
}

export function hasPendingBuckets(map: Map<string, WriteTask[]>) {
    for (const tasks of map.values()) {
        if (tasks.length) return true
    }
    return false
}
