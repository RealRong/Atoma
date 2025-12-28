import { Observability } from '#observability'
import type { ObservabilityContext, AtomaDebugEventMap, DebugEmitMeta } from '#observability'
import type { Meta, Operation, OperationResult } from '#protocol'
import type { OpsClient } from '../backend/OpsClient'
import type { OpsTask } from './types'

// ============================================================================
// Utils
// ============================================================================

export function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err))
}

export function createAbortController() {
    if (typeof AbortController === 'undefined') return undefined
    return new AbortController()
}

export function clampInt(v: number, min: number, max: number) {
    if (!Number.isFinite(v)) return min
    const n = Math.floor(v)
    if (n < min) return min
    if (n > max) return max
    return n
}

export function normalizePositiveInt(value: unknown) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
}

export function getErrorStatus(error: unknown): number | undefined {
    if (!error) return undefined
    if (typeof error !== 'object' && typeof error !== 'function') return undefined
    const status = Reflect.get(error, 'status')
    return typeof status === 'number' ? status : undefined
}

export function createCoalescedScheduler(args: {
    getDelayMs: () => number
    run: () => Promise<void> | void
}) {
    let scheduled = false
    let running = false
    let rerunRequested = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let token = 0

    const trigger = (id: number) => {
        if (disposed) return
        if (id !== token) return
        scheduled = false
        timer = undefined

        running = true
        void Promise.resolve(args.run()).finally(() => {
            running = false
            if (disposed) return
            if (!rerunRequested) return
            rerunRequested = false
            schedule()
        })
    }

    const schedule = () => {
        if (disposed) return
        if (running) {
            rerunRequested = true
            return
        }
        if (scheduled) return
        scheduled = true

        if (timer) {
            clearTimeout(timer)
            timer = undefined
        }

        const delayMs = Math.max(0, Math.floor(args.getDelayMs() ?? 0))
        token += 1
        const id = token

        if (delayMs > 0) {
            timer = setTimeout(() => trigger(id), delayMs)
            return
        }

        queueMicrotask(() => trigger(id))
    }

    const cancel = () => {
        if (timer) {
            clearTimeout(timer)
            timer = undefined
        }
        scheduled = false
        rerunRequested = false
        token += 1
    }

    const dispose = () => {
        disposed = true
        cancel()
    }

    return { schedule, cancel, dispose }
}

export type OpsRequest = {
    meta: Meta
    ops: Operation[]
}

export type OpsResult = OperationResult

export function mapOpsResults(results: unknown): Map<string, OpsResult> {
    const map = new Map<string, OpsResult>()
    if (!Array.isArray(results)) return map
    results.forEach((r: any) => {
        if (r && typeof r.opId === 'string') map.set(r.opId, r as OpsResult)
    })
    return map
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

export async function executeOpsTasksBatch(args: {
    lane: 'query' | 'write'
    endpoint: string
    tasks: OpsTask[]
    opsClient: OpsClient
    controller?: AbortController
}) {
    const requestContext = buildOpsLaneRequestContext(args.tasks)

    const opsWithTrace = args.tasks.map(t => withOpTraceMeta(t.op, t.ctx))

    const payload: OpsRequest = {
        meta: {
            v: 1,
            clientTimeMs: Date.now()
        },
        ops: opsWithTrace
    }

    const payloadBytes = requestContext.shouldEmitDataSourceEvents
        ? Observability.utf8.byteLength(JSON.stringify(payload))
        : undefined

    emitDataSourceEvent({
        targets: requestContext.ctxTargets,
        type: 'datasource:request',
        payloadFor: t => ({
            lane: args.lane,
            method: 'POST',
            endpoint: args.endpoint,
            attempt: 1,
            payloadBytes,
            opCount: t.opCount,
            taskCount: t.taskCount,
            totalOpCount: args.tasks.length,
            mixedTrace: requestContext.mixedTrace
        })
    })

    let startedAt: number | undefined
    try {
        startedAt = Date.now()
        const res = await args.opsClient.executeOps({
            ops: payload.ops,
            meta: payload.meta,
            signal: args.controller?.signal
        })
        const durationMs = Date.now() - startedAt

        emitDataSourceEvent({
            targets: requestContext.ctxTargets,
            type: 'datasource:response',
            payloadFor: t => ({
                lane: args.lane,
                ok: true,
                status: res.status,
                durationMs,
                opCount: t.opCount,
                taskCount: t.taskCount,
                totalOpCount: args.tasks.length,
                mixedTrace: requestContext.mixedTrace
            })
        })

        const resultMap = mapOpsResults(res.results)
        return opsWithTrace.map((op) => resultMap.get(op.opId) ?? missingResult(op.opId))
    } catch (error: unknown) {
        emitDataSourceEvent({
            targets: requestContext.ctxTargets,
            type: 'datasource:response',
            payloadFor: t => ({
                lane: args.lane,
                ok: false,
                status: getErrorStatus(error),
                durationMs: typeof startedAt === 'number' ? (Date.now() - startedAt) : undefined,
                opCount: t.opCount,
                taskCount: t.taskCount,
                totalOpCount: args.tasks.length,
                mixedTrace: requestContext.mixedTrace
            })
        })
        throw error
    }
}

// ============================================================================
// Config
// ============================================================================

type BatchEngineConfigLike = {
    maxQueueLength?: number | { query?: number; write?: number }
    maxBatchSize?: number
    maxOpsPerRequest?: number
}

export function normalizeMaxQueueLength(config: BatchEngineConfigLike, lane: 'query' | 'write') {
    const cfg = config.maxQueueLength
    if (typeof cfg === 'number') {
        return normalizePositiveInt(cfg) ?? Infinity
    }
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        const v = lane === 'query' ? cfg.query : cfg.write
        return normalizePositiveInt(v) ?? Infinity
    }
    return Infinity
}

export function isWriteQueueFull(config: BatchEngineConfigLike, writePendingCount: number) {
    const maxLen = normalizeMaxQueueLength(config, 'write')
    if (maxLen === Infinity) return false
    return writePendingCount >= maxLen
}

export function normalizeMaxOpsPerRequest(config: BatchEngineConfigLike) {
    const n = config.maxOpsPerRequest
    return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? Math.floor(n) : Infinity
}

// ============================================================================
// Adapter Events
// ============================================================================

type DataSourceEventType = 'datasource:request' | 'datasource:response'

export function emitDataSourceEvent<M extends { ctx?: ObservabilityContext }, TType extends DataSourceEventType>(args: {
    targets: M[]
    type: TType
    payloadFor: (m: M) => AtomaDebugEventMap[TType]
    meta?: DebugEmitMeta
}) {
    const { targets, type, payloadFor, meta } = args
    if (!targets.length) return

    targets.forEach(m => {
        try {
            m.ctx?.emit(type, payloadFor(m), meta)
        } catch {
            // ignore
        }
    })
}

type TraceState = {
    mixedTrace: boolean
}

function normalizeTraceId(traceId: unknown) {
    return typeof traceId === 'string' && traceId ? traceId : undefined
}

function buildTraceState(items: Array<{ ctx?: ObservabilityContext }>): TraceState {
    const distinct = new Set<string>()
    let hasMissing = false

    items.forEach(t => {
        const id = normalizeTraceId(t.ctx?.traceId)
        if (id) distinct.add(id)
        else hasMissing = true
    })

    const mixedTrace = distinct.size > 1 || (hasMissing && distinct.size > 0)
    return { mixedTrace }
}

export function buildOpsLaneRequestContext(tasks: Array<{ ctx?: ObservabilityContext }>) {
    const traceState = buildTraceState(tasks)

    const byCtx = new Map<ObservabilityContext, { opCount: number }>()
    tasks.forEach(t => {
        const ctx = t.ctx
        if (!ctx) return
        const cur = byCtx.get(ctx) ?? { opCount: 0 }
        cur.opCount++
        byCtx.set(ctx, cur)
    })

    const ctxTargets = Array.from(byCtx.entries()).map(([ctx, meta]) => ({
        ctx,
        opCount: meta.opCount,
        taskCount: meta.opCount
    }))
    const shouldEmitDataSourceEvents = ctxTargets.some(t => t.ctx.active)

    return {
        mixedTrace: traceState.mixedTrace,
        ctxTargets,
        shouldEmitDataSourceEvents
    }
}

function withOpTraceMeta(op: Operation, ctx?: ObservabilityContext): Operation {
    if (!ctx) return op

    const traceId = normalizeTraceId(ctx.traceId)
    const requestId = traceId ? normalizeTraceId(ctx.requestId()) : undefined
    if (!traceId && !requestId) return op

    const baseMeta = (op as any)?.meta
    const meta = (baseMeta && typeof baseMeta === 'object' && !Array.isArray(baseMeta))
        ? baseMeta
        : undefined

    return {
        ...(op as any),
        meta: {
            v: 1,
            ...(meta ? meta : {}),
            ...(traceId ? { traceId } : {}),
            ...(requestId ? { requestId } : {})
        }
    } as any
}

// ============================================================================
// Protocol Helpers
// ============================================================================

// legacy query normalization removed in ops-only mode
