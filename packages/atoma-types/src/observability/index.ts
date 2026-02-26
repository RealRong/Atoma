export type DebugConfig = {
    enabled?: boolean
    sample?: number
    payload?: boolean
    redact?: (value: unknown) => unknown
}

export type DebugEvent = {
    schemaVersion: 1
    type: string
    traceId: string
    requestId?: string
    opId?: string
    sequence: number
    timestamp: string
    scope: string
    spanId: string
    parentSpanId?: string
    payload?: unknown
}

export type PluginOptions = Readonly<{
    maxTraceEvents?: number
    maxRuntimeTraces?: number
    debug?: DebugConfig
    debugSink?: (event: DebugEvent, storeName: string) => void
}>

export type Context = {
    active: boolean
    traceId?: string
    requestId: () => string
    emit: (type: string, payload?: unknown, meta?: DebugEmitMeta) => void
    with: (meta: DebugEmitMeta) => Context
}

export type DebugEmitMeta = {
    requestId?: string
    opId?: string
    parentSpanId?: string
}
