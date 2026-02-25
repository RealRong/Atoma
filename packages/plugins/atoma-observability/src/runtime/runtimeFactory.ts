import type { Context, Tracer } from '@opentelemetry/api'
import { TraceFlags, context as otelContext, trace as otelTrace } from '@opentelemetry/api'
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/core'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'

const SAMPLING_DECISION_RECORD_AND_SAMPLED = 2

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

const hash32 = (input: string, seed: number): number => {
    let hash = (FNV_OFFSET ^ seed) >>> 0
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, FNV_PRIME)
    }
    return hash >>> 0
}

const toHex32 = (value: number): string => value.toString(16).padStart(8, '0')

const normalizeRatio = (sampleRate: number | undefined): number => {
    if (!Number.isFinite(sampleRate)) return 0
    const normalized = Number(sampleRate)
    if (normalized <= 0) return 0
    if (normalized >= 1) return 1
    return normalized
}

export const toOtelTraceId = (traceId: string): string => {
    const seed = traceId || 'trace'
    return [
        hash32(seed, 0),
        hash32(seed, 1),
        hash32(seed, 2),
        hash32(seed, 3)
    ].map(toHex32).join('')
}

const toOtelSpanId = (spanId: string): string => {
    const seed = spanId || 'span'
    return [hash32(seed, 0), hash32(seed, 1)].map(toHex32).join('')
}

export type RuntimeTelemetry = Readonly<{
    tracer: Tracer
    shouldSample: (traceId: string, spanName: string) => boolean
    parentContext: (args: { traceId: string; parentSpanId?: string; sampled: boolean }) => Context
}>

export const createRuntimeTelemetry = (args: {
    scope: string
    sampleRate: number | undefined
}): RuntimeTelemetry => {
    const ratio = normalizeRatio(args.sampleRate)
    const ratioSampler = new TraceIdRatioBasedSampler(ratio)
    const provider = new BasicTracerProvider({
        sampler: new ParentBasedSampler({
            root: ratioSampler
        })
    })

    const tracer = provider.getTracer('atoma-observability', args.scope)

    return {
        tracer,
        shouldSample: (traceId: string, spanName: string) => {
            const decision = ratioSampler.shouldSample(
                otelContext.active(),
                toOtelTraceId(`${spanName}:${traceId}`)
            )
            return decision.decision === SAMPLING_DECISION_RECORD_AND_SAMPLED
        },
        parentContext: ({ traceId, parentSpanId, sampled }) => {
            return otelTrace.setSpanContext(otelContext.active(), {
                traceId: toOtelTraceId(traceId),
                spanId: toOtelSpanId(parentSpanId ?? `root:${traceId}`),
                traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE
            })
        }
    }
}
