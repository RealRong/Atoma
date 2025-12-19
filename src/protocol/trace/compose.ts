export function inject(
    headers: Record<string, string> | undefined,
    args: { traceIdHeader: string; requestIdHeader: string; traceId?: string; requestId?: string }
) {
    const out: Record<string, string> = { ...(headers || {}) }
    if (typeof args.traceId === 'string' && args.traceId) out[args.traceIdHeader] = args.traceId
    if (typeof args.requestId === 'string' && args.requestId) out[args.requestIdHeader] = args.requestId
    return out
}
