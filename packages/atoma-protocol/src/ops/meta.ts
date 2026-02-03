import { ids } from '../ids'
import type { WriteItemMeta } from 'atoma-types/protocol'

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readFiniteNumber(value: unknown): number | undefined {
    return (typeof value === 'number' && Number.isFinite(value)) ? value : undefined
}

function readNonEmptyString(value: unknown): string | undefined {
    return (typeof value === 'string' && value.length > 0) ? value : undefined
}

export function ensureWriteItemMeta(args: {
    meta?: unknown
    now?: () => number
    defaults?: { idempotencyKey?: string; clientTimeMs?: number }
}): WriteItemMeta {
    const now = args.now ?? (() => Date.now())

    const base = isPlainObject(args.meta) ? (args.meta as Record<string, unknown>) : {}
    const existingIdempotencyKey = readNonEmptyString((base as any).idempotencyKey)
    const existingClientTimeMs = readFiniteNumber((base as any).clientTimeMs)

    const idempotencyKey = existingIdempotencyKey
        ?? readNonEmptyString(args.defaults?.idempotencyKey)
        ?? ids.createIdempotencyKey({ now })

    const clientTimeMs = existingClientTimeMs
        ?? readFiniteNumber(args.defaults?.clientTimeMs)
        ?? now()

    return {
        ...(base as any),
        idempotencyKey,
        clientTimeMs
    }
}

export function newWriteItemMeta(args?: { now?: () => number }): WriteItemMeta {
    return ensureWriteItemMeta({ now: args?.now })
}
