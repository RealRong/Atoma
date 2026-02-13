import { createIdempotencyKey } from './id'

export type WriteItemMeta = {
    idempotencyKey?: string
    clientTimeMs?: number
    [k: string]: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readFiniteNumber(value: unknown): number | undefined {
    return (typeof value === 'number' && Number.isFinite(value)) ? value : undefined
}

function readNonEmptyString(value: unknown): string | undefined {
    return (typeof value === 'string' && value.length > 0) ? value : undefined
}

export function ensureWriteItemMeta<T extends WriteItemMeta = WriteItemMeta>(args: {
    meta?: unknown
    now?: () => number
    defaults?: { idempotencyKey?: string; clientTimeMs?: number }
}): T {
    const now = args.now ?? (() => Date.now())

    const base = isPlainObject(args.meta) ? (args.meta as Record<string, unknown>) : {}
    const existingIdempotencyKey = readNonEmptyString((base as any).idempotencyKey)
    const existingClientTimeMs = readFiniteNumber((base as any).clientTimeMs)

    const idempotencyKey = existingIdempotencyKey
        ?? readNonEmptyString(args.defaults?.idempotencyKey)
        ?? createIdempotencyKey({ now })

    const clientTimeMs = existingClientTimeMs
        ?? readFiniteNumber(args.defaults?.clientTimeMs)
        ?? now()

    return {
        ...(base as any),
        idempotencyKey,
        clientTimeMs
    } as T
}

export function newWriteItemMeta<T extends WriteItemMeta = WriteItemMeta>(args?: { now?: () => number }): T {
    return ensureWriteItemMeta<T>({ now: args?.now })
}
