export function toError(err: any) {
    return err instanceof Error ? err : new Error(String(err))
}

export function createAbortController() {
    if (typeof AbortController === 'undefined') return undefined
    return new AbortController()
}

export function clampInt(v: number, min: number, max: number) {
    if (!Number.isFinite(v)) return min
    const n = Math.floor(v)
    if (n < min) return min
    if (n > max) return max
    return n
}

export function normalizePositiveInt(value: any) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
}

