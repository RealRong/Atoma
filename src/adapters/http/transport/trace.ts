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

export function traceFromArgs(args: { context?: ObservabilityContext; traceId?: string }): {
    ctx: ObservabilityContext | undefined
    headers: Record<string, string> | undefined
    traceId: string | undefined
    requestId: string | undefined
} {
    const explicitTraceId = typeof args.traceId === 'string' && args.traceId ? args.traceId : undefined
    const ctx = args.context

    if (!explicitTraceId) {
        return traceFromContext(ctx)
    }

    if (ctx && ctx.traceId === explicitTraceId) {
        return traceFromContext(ctx)
    }

    return {
        ctx,
        traceId: explicitTraceId,
        requestId: undefined,
        headers: { [Protocol.trace.headers.TRACE_ID_HEADER]: explicitTraceId }
    }
}
