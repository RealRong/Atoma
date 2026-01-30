function trimTrailingSlashes(path: string): string {
    return path.replace(/\/+$/g, '')
}

/**
 * Normalize a base URL for stable comparisons / key generation.
 * - If parseable, keep `origin + pathname` (without trailing slash).
 * - Otherwise, fallback to trimming trailing slashes from the raw string.
 */
export function normalizeBaseUrl(url: string): string {
    const raw = String(url || '').trim()
    if (!raw) return ''
    try {
        const u = new URL(raw)
        return `${u.origin}${trimTrailingSlashes(u.pathname)}`
    } catch {
        return trimTrailingSlashes(raw)
    }
}

export function resolveUrl(baseURL: string, pathOrUrl: string): string {
    const base = String(baseURL || '')
    const rel = String(pathOrUrl || '')
    try {
        return new URL(rel, base).toString()
    } catch {
        const hasTrailing = base.endsWith('/')
        const hasLeading = rel.startsWith('/')
        if (hasTrailing && hasLeading) return `${base}${rel.slice(1)}`
        if (!hasTrailing && !hasLeading) return `${base}/${rel}`
        return `${base}${rel}`
    }
}

export function withResourcesParam(url: string, resources?: string[]): string {
    if (!resources?.length) return url
    const list = resources.join(',')

    try {
        const u = new URL(url)
        u.searchParams.set('resources', list)
        return u.toString()
    } catch {
        const encoded = encodeURIComponent(list)
        return url.includes('?') ? `${url}&resources=${encoded}` : `${url}?resources=${encoded}`
    }
}

