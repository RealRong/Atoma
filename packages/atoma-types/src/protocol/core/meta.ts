export type Meta = {
    v: number
    traceId?: string
    requestId?: string
    deviceId?: string
    clientTimeMs?: number
    serverTimeMs?: number
    warnings?: Array<{ code: string; message: string; details?: unknown }>
}
