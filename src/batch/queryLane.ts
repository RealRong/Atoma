import { utf8ByteLength } from '../observability/utf8'
import { TRACE_ID_HEADER, REQUEST_ID_HEADER } from '../protocol/trace'
import { emitAdapterEvent } from './adapterEvents'
import { normalizeMaxQueryOpsPerRequest } from './config'
import { mapResults, normalizeQueryEnvelope, normalizeQueryFallback } from './protocol'
import { normalizeAtomaServerQueryParams } from './queryParams'
import type { Deferred, QueryTask } from './types'
import { clampInt, createAbortController, toError } from './utils'

type SendFn = (payload: any, signal?: AbortSignal, extraHeaders?: Record<string, string>) => Promise<{ json: any; status: number }>

export type QueryLaneEngine = {
    disposed: boolean
    disposedError: Error
    endpoint: string
    config: any
    inFlightControllers: Set<AbortController>
    inFlightTasks: Set<{ deferred: Deferred<any> }>
    queryQueue: Array<QueryTask<any>>
    queryInFlight: number
    send: SendFn
    nextOpId: (prefix: 'q' | 'w') => string
    nextRequestId: (traceId: string) => string
    signalQueryLane: () => void
}

export async function drainQueryLane(engine: QueryLaneEngine) {
    const maxInFlight = clampInt(engine.config.queryMaxInFlight ?? 2, 1, 64)
    const maxOps = normalizeMaxQueryOpsPerRequest(engine.config)

    while (!engine.disposed && engine.queryInFlight < maxInFlight && engine.queryQueue.length) {
        const { batch, remainingQueue } = takeQueryBatch(engine.queryQueue, maxOps)
        engine.queryQueue = remainingQueue

        engine.queryInFlight++
        batch.forEach(t => engine.inFlightTasks.add(t as any))
        const controller = createAbortController()
        if (controller) engine.inFlightControllers.add(controller)

        const traceState = (() => {
            const distinct = new Set<string>()
            let hasMissing = false
            batch.forEach(t => {
                const id = typeof t.ctx?.traceId === 'string' && t.ctx.traceId ? t.ctx.traceId : undefined
                if (id) distinct.add(id)
                else hasMissing = true
            })
            const commonTraceId = (!hasMissing && distinct.size === 1) ? Array.from(distinct)[0] : undefined
            const mixedTrace = distinct.size > 1 || (hasMissing && distinct.size > 0)
            return { commonTraceId, mixedTrace }
        })()
        const commonTraceId = traceState.commonTraceId
        const requestId = commonTraceId ? engine.nextRequestId(commonTraceId) : undefined
        const ctxTargets = (() => {
            const byCtx = new Map<any, { opCount: number }>()
            batch.forEach(t => {
                const ctx = t.ctx
                if (!ctx) return
                const cur = byCtx.get(ctx) ?? { opCount: 0 }
                cur.opCount++
                byCtx.set(ctx, cur)
            })
            return Array.from(byCtx.entries()).map(([baseCtx, meta]) => ({
                ctx: requestId ? baseCtx.with({ requestId }) : baseCtx,
                ...meta
            }))
        })()
        const shouldEmitAdapterEvents = ctxTargets.some(t => Boolean(t.ctx?.active))

        let startedAt: number | undefined
        try {
            const payload = {
                ...(commonTraceId ? { traceId: commonTraceId } : {}),
                ...(requestId ? { requestId } : {}),
                ops: batch.map(t => ({
                    opId: t.opId,
                    action: 'query',
                    query: {
                        resource: t.resource,
                        params: normalizeAtomaServerQueryParams(t.params)
                    }
                }))
            }

            const payloadBytes = shouldEmitAdapterEvents ? utf8ByteLength(JSON.stringify(payload)) : undefined
            emitAdapterEvent({
                targets: ctxTargets,
                type: 'adapter:request',
                payloadFor: ({ opCount }) => ({
                    lane: 'query',
                    method: 'POST',
                    endpoint: engine.endpoint,
                    attempt: 1,
                    payloadBytes,
                    opCount,
                    totalOpCount: batch.length,
                    mixedTrace: traceState.mixedTrace
                })
            })

            startedAt = Date.now()
            const response = await engine.send(payload, controller?.signal, {
                ...(commonTraceId ? { [TRACE_ID_HEADER]: commonTraceId } : {}),
                ...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {})
            })
            const durationMs = Date.now() - startedAt
            emitAdapterEvent({
                targets: ctxTargets,
                type: 'adapter:response',
                payloadFor: ({ opCount }) => ({
                    lane: 'query',
                    ok: true,
                    status: response.status,
                    durationMs,
                    opCount,
                    totalOpCount: batch.length,
                    mixedTrace: traceState.mixedTrace
                })
            })

            const resultMap = mapResults(response.json?.results)

            for (const task of batch) {
                if (engine.disposed) {
                    task.deferred.reject(engine.disposedError)
                    continue
                }
                const res = resultMap.get(task.opId)
                if (!res || res.ok === false || res.error) {
                    await runQueryFallback(task, res?.error)
                    continue
                }
                const normalized = normalizeQueryEnvelope(res)
                task.deferred.resolve(normalized)
            }
        } catch (error: any) {
            emitAdapterEvent({
                targets: ctxTargets,
                type: 'adapter:response',
                payloadFor: ({ opCount }) => ({
                    lane: 'query',
                    ok: false,
                    status: typeof (error as any)?.status === 'number' ? (error as any).status : undefined,
                    durationMs: typeof startedAt === 'number' ? (Date.now() - startedAt) : undefined,
                    opCount,
                    totalOpCount: batch.length,
                    mixedTrace: traceState.mixedTrace
                })
            })
            engine.config.onError?.(toError(error), { lane: 'query' })
            for (const task of batch) {
                if (engine.disposed) {
                    task.deferred.reject(engine.disposedError)
                    continue
                }
                await runQueryFallback(task, error)
            }
        } finally {
            if (controller) engine.inFlightControllers.delete(controller)
            batch.forEach(t => engine.inFlightTasks.delete(t as any))
            engine.queryInFlight--
        }
    }

    if (!engine.disposed && engine.queryQueue.length) {
        engine.signalQueryLane()
    }
}

function takeQueryBatch(queue: Array<QueryTask<any>>, maxOps: number) {
    const max = maxOps === Infinity ? Infinity : Math.max(1, Math.floor(maxOps))
    const normalizeTraceId = (traceId: unknown) => {
        return typeof traceId === 'string' && traceId ? traceId : undefined
    }

    const firstKey = normalizeTraceId(queue[0]?.ctx?.traceId)
    let takeCount = 0
    for (let i = 0; i < queue.length && takeCount < max; i++) {
        const task = queue[i]
        const key = normalizeTraceId(task.ctx?.traceId)
        if (key !== firstKey) break
        takeCount++
    }

    const batch = queue.splice(0, takeCount)
    return { batch, remainingQueue: queue }
}

async function runQueryFallback<T>(task: QueryTask<T>, reason?: any) {
    try {
        const res = await task.fallback()
        task.deferred.resolve(normalizeQueryFallback(res))
    } catch (fallbackError) {
        task.deferred.reject(fallbackError ?? reason)
    }
}
