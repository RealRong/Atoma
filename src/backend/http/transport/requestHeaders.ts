export async function resolveRequestHeaders(
    getBaseHeaders: () => Promise<Record<string, string>>,
    extraHeaders?: Record<string, string>
): Promise<Record<string, string>> {
    const base = await getBaseHeaders()
    if (!extraHeaders) return base
    return { ...base, ...extraHeaders }
}

