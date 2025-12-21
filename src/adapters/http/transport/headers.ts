export async function resolveHeaders(
    getBaseHeaders: () => Promise<Record<string, string>>,
    traceHeaders?: Record<string, string>,
    extraHeaders?: Record<string, string>
): Promise<Record<string, string>> {
    const base = await getBaseHeaders()
    if (!traceHeaders && !extraHeaders) return base
    return { ...base, ...(traceHeaders ?? {}), ...(extraHeaders ?? {}) }
}

