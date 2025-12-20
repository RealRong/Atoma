import type { DebugConfig, DebugEvent, ObservabilityContext } from '../types'
import type { DebugEmitMeta } from '../types'
import { shouldSampleTrace } from '../sampling'
import { createTraceId, deriveRequestId } from '../trace'
import type { ObservabilityCreateContextArgs, ObservabilityRuntimeApi, ObservabilityRuntimeCreateArgs } from './types'

type TraceSlot = {
    eventSeq: number
    requestSeq: number
    ctxActive?: ObservabilityContext
    ctxInactive?: ObservabilityContext
}

const NOOP_EMIT: ObservabilityContext['emit'] = () => {}

const NOOP_CONTEXT: ObservabilityContext = {
    active: false,
    traceId: undefined,
    emit: NOOP_EMIT,
    with: () => NOOP_CONTEXT
}

const summarizeValue = (value: unknown): unknown => {
    if (value === null) return null
    const t = typeof value
    if (t === 'undefined') return undefined
    if (t === 'number' || t === 'boolean') return value
    if (t === 'string') return { type: 'string', length: (value as string).length }
    if (t === 'bigint' || t === 'function' || t === 'symbol') return { type: t }
    if (Array.isArray(value)) return { type: 'array', length: value.length }
    if (value && t === 'object') {
        const keys = Object.keys(value as any)
        return { type: 'object', keyCount: keys.length, keys: keys.slice(0, 20) }
    }
    return { type: 'unknown' }
}

const hasAnyMeta = (meta: DebugEmitMeta | undefined): boolean => {
    if (!meta) return false
    return Boolean(meta.requestId || meta.opId || meta.parentSpanId)
}

export class ObservabilityRuntime implements ObservabilityRuntimeApi {
    readonly scope: string

    private readonly debug: DebugConfig | undefined
    private readonly onEvent: ((e: DebugEvent) => void) | undefined
    private readonly maxTraces: number
    private readonly traces = new Map<string, TraceSlot>()

    constructor(args: ObservabilityRuntimeCreateArgs) {
        this.scope = args.scope
        this.debug = args.debug
        this.onEvent = args.onEvent
        this.maxTraces = Math.max(1, Math.floor(args.maxTraces ?? 1024))
    }

    requestId(traceId: string): string {
        if (typeof traceId !== 'string' || !traceId) return deriveRequestId('t_missing', 1)
        const slot = this.getTraceSlot(traceId)
        slot.requestSeq += 1
        return deriveRequestId(traceId, slot.requestSeq)
    }

    createContext(args?: ObservabilityCreateContextArgs): ObservabilityContext {
        const provided = typeof args?.traceId === 'string' && args.traceId ? args.traceId : undefined
        const explain = args?.explain === true

        const debug = this.debug
        const debugEnabled = Boolean(debug?.enabled && this.onEvent)
        const sampleRate = typeof debug?.sampleRate === 'number' ? debug.sampleRate : 0

        const shouldAllocateTraceId = Boolean(
            provided ||
            explain ||
            (debugEnabled && Number.isFinite(sampleRate) && sampleRate > 0)
        )

        const traceId = provided || (shouldAllocateTraceId ? createTraceId() : undefined)
        if (!traceId) return NOOP_CONTEXT

        const active = Boolean(debugEnabled && shouldSampleTrace(traceId, sampleRate))
        const slot = this.getTraceSlot(traceId)

        if (active) {
            if (!slot.ctxActive) {
                slot.ctxActive = this.createBaseContext({ traceId, active: true })
            }
            return slot.ctxActive
        }

        if (!slot.ctxInactive) {
            slot.ctxInactive = this.createBaseContext({ traceId, active: false })
        }
        return slot.ctxInactive
    }

    private getTraceSlot(traceId: string): TraceSlot {
        const existing = this.traces.get(traceId)
        if (existing) {
            this.traces.delete(traceId)
            this.traces.set(traceId, existing)
            return existing
        }

        const next: TraceSlot = { eventSeq: 0, requestSeq: 0 }
        this.traces.set(traceId, next)

        if (this.traces.size > this.maxTraces) {
            const first = this.traces.keys().next().value
            if (typeof first === 'string') this.traces.delete(first)
        }

        return next
    }

    private nextEventSequence(traceId: string): number {
        const slot = this.getTraceSlot(traceId)
        slot.eventSeq += 1
        return slot.eventSeq
    }

    private createBaseContext(args: { traceId: string; active: boolean }): ObservabilityContext {
        const { traceId, active } = args

        if (!active) {
            const ctx: ObservabilityContext = {
                active: false,
                traceId,
                emit: NOOP_EMIT,
                with: () => ctx
            }
            return ctx
        }

        const createWithDefaultMeta = (defaultMeta?: DebugEmitMeta): ObservabilityContext => {
            const emit: ObservabilityContext['emit'] = (type, data, meta) => {
                this.emitEvent({ traceId, type, data, defaultMeta, meta })
            }

            const ctx: ObservabilityContext = {
                active: true,
                traceId,
                emit,
                with: (nextMeta) => {
                    if (!hasAnyMeta(nextMeta)) return ctx
                    const merged: DebugEmitMeta = {
                        requestId: nextMeta.requestId ?? defaultMeta?.requestId,
                        opId: nextMeta.opId ?? defaultMeta?.opId,
                        parentSpanId: nextMeta.parentSpanId ?? defaultMeta?.parentSpanId
                    }
                    return createWithDefaultMeta(merged)
                }
            }

            return ctx
        }

        return createWithDefaultMeta(undefined)
    }

    private emitEvent(args: {
        traceId: string
        type: string
        data: unknown
        defaultMeta: DebugEmitMeta | undefined
        meta: DebugEmitMeta | undefined
    }) {
        const debug = this.debug
        const sink = this.onEvent
        if (!debug?.enabled || !sink) return

        const traceId = args.traceId
        const type = args.type
        const sequence = this.nextEventSequence(traceId)

        const requestId = args.meta?.requestId ?? args.defaultMeta?.requestId
        const opId = args.meta?.opId ?? args.defaultMeta?.opId
        const parentSpanId = args.meta?.parentSpanId ?? args.defaultMeta?.parentSpanId

        const safePayload = (() => {
            const redacted = debug.redact ? debug.redact(args.data) : args.data
            if (debug.includePayload) return redacted
            return summarizeValue(redacted)
        })()

        const e: DebugEvent = {
            schemaVersion: 1,
            type,
            traceId,
            requestId,
            opId,
            sequence,
            timestamp: new Date().toISOString(),
            scope: this.scope,
            spanId: `s_${sequence}`,
            parentSpanId,
            payload: safePayload
        }

        try {
            sink(e)
        } catch {
            // ignore
        }
    }
}
