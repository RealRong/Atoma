export function normalizeName(value: string): string {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '')
    return normalized.slice(0, 48)
}

export function readVersion(value: unknown): number | undefined {
    const version = Number(value)
    if (!Number.isFinite(version)) return undefined
    if (version < 1) return undefined
    return Math.floor(version)
}

export function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

export function toError(error: unknown, fallbackMessage = '[Sync] Unknown error'): Error {
    if (error instanceof Error) {
        return error
    }

    const message = typeof error === 'string'
        ? error
        : fallbackMessage
    return new Error(message)
}
