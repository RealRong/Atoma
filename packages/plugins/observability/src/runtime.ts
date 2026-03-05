import type { Context, DebugConfig, DebugEmitMeta, DebugEvent } from '@atoma-js/types/observability'
import QuickLRU from 'quick-lru'
import { isSampled } from './utils/sampling'
import { createId, requestId } from './utils/trace'

type RuntimeCreateArgs = {
    debug?: DebugConfig
    onEvent?: (event: DebugEvent) => void
    maxTraces?: number
}

type CreateContextArgs = {
    traceId?: string
    scope?: string
}

type TraceSlot = {
    eventSeq: number
    requestSeq: number
}

const NOOP_EMIT: Context['emit'] = () => { }
const DEFAULT_SCOPE = 'store'

const NOOP_CONTEXT: Context = {
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

export class Runtime {
    private readonly debug: DebugConfig | undefined
    private readonly onEvent: ((event: DebugEvent) => void) | undefined
    private readonly traces: QuickLRU<string, TraceSlot>

    constructor({ debug, onEvent, maxTraces }: RuntimeCreateArgs) {
        this.debug = debug
        this.onEvent = onEvent
        this.traces = new QuickLRU<string, TraceSlot>({
            maxSize: Math.max(1, Math.floor(maxTraces ?? 1024))
        })
    }

    requestId(traceId: string): string {
        if (typeof traceId !== 'string' || !traceId) return requestId('t_missing', 1)
        const slot = this.getTraceSlot(traceId)
        slot.requestSeq += 1
        return requestId(traceId, slot.requestSeq)
    }

    createContext(args?: CreateContextArgs): Context {
        const provided = typeof args?.traceId === 'string' && args.traceId ? args.traceId : undefined
        const scope = typeof args?.scope === 'string' && args.scope ? args.scope : DEFAULT_SCOPE

        const debugEnabled = Boolean(this.debug?.enabled && this.onEvent)
        const sample = typeof this.debug?.sample === 'number' ? this.debug.sample : 0
        const shouldAllocateTraceId = Boolean(provided || debugEnabled)

        const traceId = provided || (shouldAllocateTraceId ? createId() : undefined)
        if (!traceId) return NOOP_CONTEXT

        const active = Boolean(debugEnabled && isSampled(traceId, sample))
        return this.createBaseContext({
            traceId,
            active,
            scope
        })
    }

    private getTraceSlot(traceId: string): TraceSlot {
        const existing = this.traces.get(traceId)
        if (existing) return existing

        const next: TraceSlot = {
            eventSeq: 0,
            requestSeq: 0
        }
        this.traces.set(traceId, next)
        return next
    }

    private createBaseContext(args: { traceId: string; active: boolean; scope: string }): Context {
        const { traceId, active, scope } = args

        if (!active) {
            const context: Context = {
                active: false,
                traceId,
                requestId: () => this.requestId(traceId),
                emit: NOOP_EMIT,
                with: () => context
            }
            return context
        }

        const createWithDefaultMeta = (defaultMeta?: DebugEmitMeta): Context => {
            const emit: Context['emit'] = (type, payload, meta) => {
                this.emitEvent({
                    traceId,
                    scope,
                    type,
                    payload,
                    defaultMeta,
                    meta
                })
            }

            const context: Context = {
                active: true,
                traceId,
                requestId: () => this.requestId(traceId),
                emit,
                with: (nextMeta) => {
                    if (!nextMeta || (!nextMeta.requestId && !nextMeta.opId && !nextMeta.parentSpanId)) return context

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
        scope: string
        type: string
        payload: unknown
        defaultMeta: DebugEmitMeta | undefined
        meta: DebugEmitMeta | undefined
    }) {
        if (!this.debug?.enabled || !this.onEvent) return

        const slot = this.getTraceSlot(args.traceId)
        slot.eventSeq += 1
        const sequence = slot.eventSeq

        const requestId = args.meta?.requestId ?? args.defaultMeta?.requestId
        const opId = args.meta?.opId ?? args.defaultMeta?.opId
        const parentSpanId = args.meta?.parentSpanId ?? args.defaultMeta?.parentSpanId

        const redacted = this.debug.redact ? this.debug.redact(args.payload) : args.payload
        const safePayload = this.debug.payload ? redacted : summarizeValue(redacted)

        const event: DebugEvent = {
            schemaVersion: 1,
            type: args.type,
            traceId: args.traceId,
            requestId,
            opId,
            sequence,
            timestamp: new Date().toISOString(),
            scope: args.scope,
            spanId: `s_${sequence}`,
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
