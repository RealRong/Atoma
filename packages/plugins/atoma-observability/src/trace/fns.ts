import { createId as createSharedId } from 'atoma-shared'
import type { RequestSequencer } from './types'

export function createId(): string {
    return createSharedId({
        kind: 'request',
        prefix: 't'
    })
}

export function requestId(traceId: string, seq: number): string {
    const safeSeq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 1
    return `r_${traceId}_${safeSeq}`
}

export function createRequestSequencer(options?: { maxTraces?: number }): RequestSequencer {
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

        return requestId(traceId, nextSeq)
    }

    return { next }
}
