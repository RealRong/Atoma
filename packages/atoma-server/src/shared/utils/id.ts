export function normalizeId(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (value === undefined || value === null) return ''
    return String(value)
}
