import { createId as createSharedId } from '@atoma-js/shared'

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
