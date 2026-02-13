import { ensureWriteItemMeta as ensureSharedWriteItemMeta } from 'atoma-shared'
import type { WriteItemMeta } from 'atoma-types/protocol'

export function ensureWriteItemMeta(args: {
    meta?: unknown
    now?: () => number
    defaults?: { idempotencyKey?: string; clientTimeMs?: number }
}): WriteItemMeta {
    return ensureSharedWriteItemMeta<WriteItemMeta>(args)
}

export function newWriteItemMeta(args?: { now?: () => number }): WriteItemMeta {
    return ensureWriteItemMeta({ now: args?.now })
}
