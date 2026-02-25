import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import QuickLRU from 'quick-lru'
import type { DebugConfig, DebugEmitMeta, DebugEvent, ObservabilityContext } from 'atoma-types/observability'
import { createId, requestId } from '../trace'
import type { ObservabilityCreateContextArgs, ObservabilityRuntimeApi, ObservabilityRuntimeCreateArgs } from './types'
import { createRuntimeTelemetry } from './runtimeFactory'

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
    requestId: () => '',
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
        const keys = Object.keys(value as Record<string, unknown>)
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
    private readonly traceSlots: QuickLRU<string, TraceSlot>
    private readonly telemetry: ReturnType<typeof createRuntimeTelemetry>

    constructor(args: ObservabilityRuntimeCreateArgs) {
        this.scope = args.scope
        this.debug = args.debug
        this.onEvent = args.onEvent

        const maxTraces = Math.max(1, Math.floor(args.maxTraces ?? 1024))
        this.traceSlots = new QuickLRU({ maxSize: maxTraces })
        this.telemetry = createRuntimeTelemetry({
            scope: args.scope,
            sampleRate: args.debug?.sample
        })
    }

    requestId(traceId: string): string {
        if (typeof traceId !== 'string' || !traceId) return requestId('t_missing', 1)
        const slot = this.getTraceSlot(traceId)
        slot.requestSeq += 1
        return requestId(traceId, slot.requestSeq)
    }

    createContext(args?: ObservabilityCreateContextArgs): ObservabilityContext {
        const provided = typeof args?.traceId === 'string' && args.traceId ? args.traceId : undefined
        const explain = args?.explain === true

        const debugEnabled = Boolean(this.debug?.enabled && this.onEvent)
        const sample = typeof this.debug?.sample === 'number' ? this.debug.sample : 0

        const shouldAllocateTraceId = Boolean(
            provided ||
            explain ||
            (debugEnabled && Number.isFinite(sample) && sample > 0)
        )

        const traceId = provided || (shouldAllocateTraceId ? createId() : undefined)
        if (!traceId) return NOOP_CONTEXT

        const active = Boolean(debugEnabled && this.telemetry.shouldSample(traceId, 'atoma-observability'))
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
        const existing = this.traceSlots.get(traceId)
        if (existing) return existing

        const next: TraceSlot = {
            eventSeq: 0,
            requestSeq: 0
        }
        this.traceSlots.set(traceId, next)
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
            const context: ObservabilityContext = {
                active: false,
                traceId,
                requestId: () => this.requestId(traceId),
                emit: NOOP_EMIT,
                with: () => context
            }
            return context
        }

        const createWithDefaultMeta = (defaultMeta?: DebugEmitMeta): ObservabilityContext => {
            const emit: ObservabilityContext['emit'] = (type, payload, meta) => {
                this.emitEvent({
                    traceId,
                    type,
                    payload,
                    defaultMeta,
                    meta
                })
            }

            const context: ObservabilityContext = {
                active: true,
                traceId,
                requestId: () => this.requestId(traceId),
                emit,
                with: (nextMeta) => {
                    if (!hasAnyMeta(nextMeta)) return context

                    const merged: DebugEmitMeta = {
                        requestId: nextMeta.requestId ?? defaultMeta?.requestId,
                        opId: nextMeta.opId ?? defaultMeta?.opId,
                        parentSpanId: nextMeta.parentSpanId ?? defaultMeta?.parentSpanId
                    }

                    return createWithDefaultMeta(merged)
                }
            }

            return context
        }

        return createWithDefaultMeta(undefined)
    }

    private emitEvent(args: {
        traceId: string
        type: string
        payload: unknown
        defaultMeta: DebugEmitMeta | undefined
        meta: DebugEmitMeta | undefined
    }) {
        if (!this.debug?.enabled || !this.onEvent) return

        const traceId = args.traceId
        const type = args.type
        const sequence = this.nextEventSequence(traceId)

        const requestId = args.meta?.requestId ?? args.defaultMeta?.requestId
        const opId = args.meta?.opId ?? args.defaultMeta?.opId
        const parentSpanId = args.meta?.parentSpanId ?? args.defaultMeta?.parentSpanId

        const safePayload = (() => {
            const redacted = this.debug?.redact ? this.debug.redact(args.payload) : args.payload
            if (this.debug?.payload) return redacted
            return summarizeValue(redacted)
        })()

        const attributes: Record<string, string | number | boolean> = {
            'atoma.scope': this.scope,
            'atoma.sequence': sequence,
            'atoma.trace_id': traceId,
            'atoma.type': type
        }

        if (requestId) attributes['atoma.request_id'] = requestId
        if (opId) attributes['atoma.op_id'] = opId

        const span = this.telemetry.tracer.startSpan(type, {
            kind: SpanKind.INTERNAL,
            attributes
        }, this.telemetry.parentContext({
            traceId,
            parentSpanId,
            sampled: true
        }))
        span.setStatus({ code: SpanStatusCode.OK })
        span.end()

        const event: DebugEvent = {
            schemaVersion: 1,
            type,
            traceId,
            requestId,
            opId,
            sequence,
            timestamp: new Date().toISOString(),
            scope: this.scope,
            spanId: span.spanContext().spanId,
            parentSpanId,
            payload: safePayload
        }

        try {
            this.onEvent(event)
        } catch {
            // ignore
        }
    }
}
