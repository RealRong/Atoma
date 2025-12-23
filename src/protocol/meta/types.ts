export type Meta = {
    v: number
    traceId?: string
    requestId?: string
    deviceId?: string
    clientTimeMs?: number
    serverTimeMs?: number
    warnings?: Array<{ code: string; message: string; details?: unknown }>
}

export function ensureMeta(meta: unknown, fallback: Meta): Meta {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return fallback
    const v = (meta as any).v
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    return meta as Meta
}

