import { isRecord as sharedIsRecord, toErrorWithFallback } from 'atoma-shared'

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
    return sharedIsRecord(value)
}

export function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

export function toError(error: unknown, fallbackMessage = '[Sync] Unknown error'): Error {
    return toErrorWithFallback(error, fallbackMessage)
}
