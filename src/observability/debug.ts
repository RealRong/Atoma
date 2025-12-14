import type { DebugEmitter, DebugEvent, DebugOptions } from './types'
import { shouldSampleTrace } from './sampling'

export type { DebugEmitter } from './types'

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

const SEQ_MAP = Symbol.for('atoma.debug.seqByTraceId')

export function createDebugEmitter(args: {
    debug?: DebugOptions
    traceId?: string
    store: string
    sink?: (e: DebugEvent) => void
}): DebugEmitter | undefined {
    const debug = args.debug
    const traceId = args.traceId
    const sink = args.sink
    if (!debug?.enabled || !sink) return undefined
    if (typeof traceId !== 'string' || !traceId) return undefined
    const sampleRate = typeof debug.sampleRate === 'number' ? debug.sampleRate : 0
    if (!shouldSampleTrace(traceId, sampleRate)) return undefined

    const seqByTraceId: Map<string, number> = (() => {
        const anyDebug = debug as any
        const existing = anyDebug?.[SEQ_MAP]
        if (existing instanceof Map) return existing
        const next = new Map<string, number>()
        try {
            anyDebug[SEQ_MAP] = next
        } catch {
            // ignore
        }
        return next
    })()

    const nextSequence = () => {
        const cur = seqByTraceId.get(traceId) ?? 0
        const next = cur + 1
        seqByTraceId.set(traceId, next)
        if (seqByTraceId.size > 1024) {
            const first = seqByTraceId.keys().next().value
            if (typeof first === 'string') seqByTraceId.delete(first)
        }
        return next
    }

    const emit: DebugEmitter['emit'] = (type, payload, meta) => {
        const safePayload = (() => {
            const redacted = debug.redact ? debug.redact(payload) : payload
            if (debug.includePayload) return redacted
            return summarizeValue(redacted)
        })()

        const sequence = nextSequence()
        const e: DebugEvent = {
            schemaVersion: 1,
            type,
            traceId,
            requestId: meta?.requestId,
            opId: meta?.opId,
            sequence,
            timestamp: new Date().toISOString(),
            store: args.store,
            spanId: `s_${sequence}`,
            parentSpanId: meta?.parentSpanId,
            payload: safePayload
        }

        try {
            sink(e)
        } catch {
            // ignore
        }
    }

    return { traceId, emit }
}
