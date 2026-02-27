export function hasHeader(headers: Record<string, string>, name: string): boolean {
    const needle = name.toLowerCase()
    return Object.keys(headers).some((key) => key.toLowerCase() === needle)
}

export function joinUrl(base: string, path: string): string {
    if (!base) return path
    if (!path) return base

    const hasTrailing = base.endsWith('/')
    const hasLeading = path.startsWith('/')

    if (hasTrailing && hasLeading) return `${base}${path.slice(1)}`
    if (!hasTrailing && !hasLeading) return `${base}/${path}`
    return `${base}${path}`
}
