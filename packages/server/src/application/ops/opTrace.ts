import type { QueryOp, WriteOp } from '@atoma-js/types/protocol'

export type TraceMeta = {
    traceId?: string
    requestId?: string
    opId: string
}

export function collectOpTrace(ops: Array<QueryOp | WriteOp>) {
    const traceByOpId = new Map<string, { traceId?: string; requestId?: string }>()

    ops.forEach(op => {
        const traceId = (op.meta && typeof op.meta.traceId === 'string' && op.meta.traceId) ? op.meta.traceId : undefined
        const requestId = (op.meta && typeof op.meta.requestId === 'string' && op.meta.requestId) ? op.meta.requestId : undefined
        if (traceId || requestId) traceByOpId.set(op.opId, { traceId, requestId })
    })

    return (opId: string): TraceMeta => {
        const trace = traceByOpId.get(opId)
        return { traceId: trace?.traceId, requestId: trace?.requestId, opId }
    }
}
