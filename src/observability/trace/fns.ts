import type { RequestIdSequencer } from './types'

const randomIdFallback = () => {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export function createTraceId(): string {
    const cryptoAny = globalThis.crypto as any
    const uuid = cryptoAny?.randomUUID?.()
    const base = typeof uuid === 'string' && uuid ? uuid : randomIdFallback()
    return `t_${base}`
}

export function deriveRequestId(traceId: string, seq: number): string {
    const safeSeq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 1
    return `r_${traceId}_${safeSeq}`
}

export function createRequestIdSequencer(options?: { maxTraces?: number }): RequestIdSequencer {
    const maxTraces = Math.max(16, Math.floor(options?.maxTraces ?? 1024))
    const seqByTraceId = new Map<string, number>()

    const next = (traceId: string) => {
        const cur = seqByTraceId.get(traceId) ?? 0
        const nextSeq = cur + 1
        seqByTraceId.set(traceId, nextSeq)

        if (seqByTraceId.size > maxTraces) {
            const first = seqByTraceId.keys().next().value
            if (typeof first === 'string') seqByTraceId.delete(first)
        }

        return deriveRequestId(traceId, nextSeq)
    }

    return { next }
}
