import { Observability } from '#observability'
import type { ObservabilityContext, AtomaDebugEventMap, DebugEmitMeta } from '#observability'
import { Protocol } from '#protocol'
import type { Meta, Operation, OperationResult } from '#protocol'
import type { FetchFn } from './types'

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
    let microtaskQueued = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let rerunRequested = false
    let rerunImmediate = false
    let disposed = false

    const trigger = () => {
        microtaskQueued = false
        if (disposed) return

        if (running) {
            rerunRequested = true
            return
        }

        if (timer) {
            clearTimeout(timer)
            timer = undefined
        }

        running = true
        void Promise.resolve(args.run()).finally(() => {
            running = false
            if (disposed) return

            if (rerunRequested) {
                rerunRequested = false
                const immediate = rerunImmediate
                rerunImmediate = false
                scheduled = false
                schedule(immediate)
                return
            }

            scheduled = false
        })
    }

    const schedule = (immediate: boolean) => {
        if (disposed) return

        if (scheduled) {
            rerunRequested = true
            rerunImmediate = rerunImmediate || immediate
            if (immediate && timer) {
                clearTimeout(timer)
                timer = undefined
                if (!microtaskQueued) {
                    microtaskQueued = true
                    queueMicrotask(trigger)
                }
            }
            return
        }

        scheduled = true

        const delay = args.getDelayMs()
        if (!immediate && delay > 0) {
            timer = setTimeout(trigger, delay)
            return
        }

        microtaskQueued = true
        queueMicrotask(trigger)
    }

    const cancel = () => {
        if (timer) {
            clearTimeout(timer)
            timer = undefined
        }
        microtaskQueued = false
        rerunRequested = false
        rerunImmediate = false
        scheduled = false
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

type SendFn = (payload: OpsRequest, signal?: AbortSignal, extraHeaders?: Record<string, string>) => Promise<{ json: unknown; status: number }>

export function mapOpsResults(results: unknown): Map<string, OpsResult> {
    const map = new Map<string, OpsResult>()
    if (!Array.isArray(results)) return map
    results.forEach((r: any) => {
        if (r && typeof r.opId === 'string') map.set(r.opId, r as OpsResult)
    })
    return map
}

export async function sendOpsWithAdapterEvents(args: {
    lane: 'query' | 'write'
    endpoint: string
    payload: OpsRequest
    send: SendFn
    controller?: AbortController
    ctxTargets: Array<{ ctx: ObservabilityContext; opCount?: number; taskCount?: number }>
    totalOpCount: number
    mixedTrace: boolean
}) {
    const shouldEmitAdapterEvents = args.ctxTargets.some(t => t.ctx.active)
    const payloadBytes = shouldEmitAdapterEvents ? Observability.utf8.byteLength(JSON.stringify(args.payload)) : undefined

    emitAdapterEvent({
        targets: args.ctxTargets,
        type: 'adapter:request',
        payloadFor: t => ({
            lane: args.lane,
            method: 'POST',
            endpoint: args.endpoint,
            attempt: 1,
            payloadBytes,
            opCount: t.opCount,
            taskCount: t.taskCount,
            totalOpCount: args.totalOpCount,
            mixedTrace: args.mixedTrace
        })
    })

    let startedAt: number | undefined
    try {
        const traceId = typeof args.payload.meta?.traceId === 'string' && args.payload.meta.traceId ? args.payload.meta.traceId : undefined
        const requestId = typeof args.payload.meta?.requestId === 'string' && args.payload.meta.requestId ? args.payload.meta.requestId : undefined

        startedAt = Date.now()
        const response = await args.send(args.payload, args.controller?.signal, {
            ...(traceId ? { [Protocol.trace.headers.TRACE_ID_HEADER]: traceId } : {}),
            ...(requestId ? { [Protocol.trace.headers.REQUEST_ID_HEADER]: requestId } : {})
        })
        const durationMs = Date.now() - startedAt

        const envelope = parseOpsEnvelopeFromJson<unknown>(response.json)

        if (!envelope.ok) {
            const err = new Error(envelope.error?.message ?? 'Ops request failed')
            ;(err as any).status = response.status
            ;(err as any).envelope = envelope
            throw err
        }

        emitAdapterEvent({
            targets: args.ctxTargets,
            type: 'adapter:response',
            payloadFor: t => ({
                lane: args.lane,
                ok: true,
                status: response.status,
                durationMs,
                opCount: t.opCount,
                taskCount: t.taskCount,
                totalOpCount: args.totalOpCount,
                mixedTrace: args.mixedTrace
            })
        })

        const results = (envelope.data && typeof envelope.data === 'object')
            ? Reflect.get(envelope.data as any, 'results')
            : undefined
        const resultMap = mapOpsResults(results)

        return { status: response.status, durationMs, resultMap }
    } catch (error: unknown) {
        emitAdapterEvent({
            targets: args.ctxTargets,
            type: 'adapter:response',
            payloadFor: t => ({
                lane: args.lane,
                ok: false,
                status: getErrorStatus(error),
                durationMs: typeof startedAt === 'number' ? (Date.now() - startedAt) : undefined,
                opCount: t.opCount,
                taskCount: t.taskCount,
                totalOpCount: args.totalOpCount,
                mixedTrace: args.mixedTrace
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

type AdapterEventType = 'adapter:request' | 'adapter:response'

export function emitAdapterEvent<M extends { ctx?: ObservabilityContext }, TType extends AdapterEventType>(args: {
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
    commonTraceId?: string
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

    const commonTraceId = (!hasMissing && distinct.size === 1) ? Array.from(distinct)[0] : undefined
    const mixedTrace = distinct.size > 1 || (hasMissing && distinct.size > 0)
    return { commonTraceId, mixedTrace }
}

export function buildOpsLaneRequestContext(tasks: Array<{ ctx?: ObservabilityContext }>) {
    const traceState = buildTraceState(tasks)
    const requestId = (() => {
        if (!traceState.commonTraceId) return undefined
        for (const t of tasks) {
            if (t.ctx) return t.ctx.requestId()
        }
        return undefined
    })()

    const byCtx = new Map<ObservabilityContext, { opCount: number }>()
    tasks.forEach(t => {
        const ctx = t.ctx
        if (!ctx) return
        const cur = byCtx.get(ctx) ?? { opCount: 0 }
        cur.opCount++
        byCtx.set(ctx, cur)
    })

    const ctxTargets = Array.from(byCtx.entries()).map(([ctx, meta]) => ({
        ctx: requestId ? ctx.with({ requestId }) : ctx,
        opCount: meta.opCount,
        taskCount: meta.opCount
    }))
    const shouldEmitAdapterEvents = ctxTargets.some(t => t.ctx.active)

    return {
        commonTraceId: traceState.commonTraceId,
        requestId,
        mixedTrace: traceState.mixedTrace,
        ctxTargets,
        shouldEmitAdapterEvents
    }
}

// ============================================================================
// Transport
// ============================================================================

type HeadersResolver = () => Promise<Record<string, string>> | Record<string, string>

export async function resolveHeaders(headers?: HeadersResolver): Promise<Record<string, string>> {
    if (!headers) return {}
    const h = headers()
    return h instanceof Promise ? await h : h
}

export async function sendBatchRequest(
    fetcher: FetchFn,
    endpoint: string,
    headers: HeadersResolver | undefined,
    payload: unknown,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>
) {
    const resolvedHeaders = await resolveHeaders(headers)
    const response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...resolvedHeaders,
            ...(extraHeaders || {})
        },
        body: JSON.stringify(payload),
        signal
    })

    const status = typeof (response as any)?.status === 'number' ? (response as any).status : 0
    const json = await (response as any).json?.().catch?.(() => null) ?? await (async () => {
        try {
            return await (response as any).json()
        } catch {
            return null
        }
    })()

    return { json, status }
}

// ============================================================================
// Protocol Helpers
// ============================================================================

function parseOpsEnvelopeFromJson<T = unknown>(json: unknown) {
    const fallback = { v: 1 }
    return Protocol.ops.parse.envelope<T>(json, fallback)
}

// legacy query normalization removed in ops-only mode
