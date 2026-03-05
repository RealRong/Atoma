export function normalizePositiveInt(value: unknown): number | undefined
export function normalizePositiveInt(value: unknown, fallback: number): number
export function normalizePositiveInt(value: unknown, fallback?: number): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
    return Math.floor(value)
}

export function normalizeNonNegativeInt(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
    return Math.floor(value)
}
