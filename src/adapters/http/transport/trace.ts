import type { ObservabilityContext } from '#observability'
import { Protocol } from '#protocol'

export function traceFromContext(context?: ObservabilityContext): {
    ctx: ObservabilityContext | undefined
    headers: Record<string, string> | undefined
    traceId: string | undefined
    requestId: string | undefined
} {
    const traceId = typeof context?.traceId === 'string' ? context.traceId : undefined
    if (!context || !traceId) return { ctx: context, headers: undefined, traceId, requestId: undefined }

    const requestId = context.requestId()
    const headers: Record<string, string> = {
        [Protocol.trace.headers.TRACE_ID_HEADER]: traceId,
        ...(requestId ? { [Protocol.trace.headers.REQUEST_ID_HEADER]: requestId } : {})
    }
    const ctx = requestId ? context.with({ requestId }) : context
    return { ctx, headers, traceId, requestId }
}