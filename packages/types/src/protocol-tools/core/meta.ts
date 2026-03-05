import type { Meta } from 'atoma-types/protocol'

export function ensureMeta(meta: unknown, fallback: Meta): Meta {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return fallback
    const v = (meta as any).v
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    return meta as Meta
}
