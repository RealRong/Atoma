import type { DebugEmitter } from '../observability/debug'
import { utf8ByteLength } from '../observability/utf8'
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

        const traceId = batch[0]?.traceId
        const requestId = traceId ? engine.nextRequestId(traceId) : undefined
        const debugEmitter = (() => {
            const emitters = batch
                .map(t => t.debugEmitter)
                .filter((e): e is DebugEmitter => Boolean(e))
            if (!emitters.length) return undefined
            const uniq = new Set(emitters)
            return uniq.size === 1 ? emitters[0] : undefined
        })()

        let startedAt: number | undefined
        try {
            const payload = {
                ...(traceId ? { traceId } : {}),
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

            const payloadBytes = debugEmitter ? utf8ByteLength(JSON.stringify(payload)) : undefined
            debugEmitter?.emit('adapter:request', {
                lane: 'query',
                method: 'POST',
                endpoint: engine.endpoint,
                attempt: 1,
                payloadBytes,
                opCount: batch.length
            }, { requestId })

            startedAt = Date.now()
            const response = await engine.send(payload, controller?.signal, {
                ...(traceId ? { 'x-atoma-trace-id': traceId } : {}),
                ...(requestId ? { 'x-atoma-request-id': requestId } : {})
            })
            const durationMs = Date.now() - startedAt
            debugEmitter?.emit('adapter:response', {
                lane: 'query',
                ok: true,
                status: response.status,
                durationMs,
                opCount: batch.length
            }, { requestId })

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
            debugEmitter?.emit('adapter:response', {
                lane: 'query',
                ok: false,
                status: typeof (error as any)?.status === 'number' ? (error as any).status : undefined,
                durationMs: typeof startedAt === 'number' ? (Date.now() - startedAt) : undefined
            }, { requestId })
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
    const traceId = queue[0]?.traceId

    if (!traceId) {
        const batch = queue.splice(0, max === Infinity ? queue.length : Math.min(queue.length, max))
        return { batch, remainingQueue: queue }
    }

    const batch: Array<QueryTask<any>> = []
    for (let i = 0; i < queue.length && batch.length < max; i++) {
        const task = queue[i]
        if (task.traceId !== traceId) continue
        batch.push(task)
    }

    if (!batch.length) {
        const fallbackBatch = queue.splice(0, max === Infinity ? queue.length : Math.min(queue.length, max))
        return { batch: fallbackBatch, remainingQueue: queue }
    }

    const picked = new Set(batch)
    const remainingQueue = queue.filter(t => !picked.has(t))
    return { batch, remainingQueue }
}

async function runQueryFallback<T>(task: QueryTask<T>, reason?: any) {
    try {
        const res = await task.fallback()
        task.deferred.resolve(normalizeQueryFallback(res))
    } catch (fallbackError) {
        task.deferred.reject(fallbackError ?? reason)
    }
}
