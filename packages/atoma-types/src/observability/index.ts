export type TraceContext = {
    traceId: string
    requestId?: string
    opId?: string
}

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

export type Explain = {
    schemaVersion: 1
    traceId: string
    requestId?: string
    opId?: string
    events?: DebugEvent[]
    index?: {
        kind: 'unsupported' | 'empty' | 'candidates'
        exactness?: 'exact' | 'superset'
        candidates?: number
        lastQueryPlan?: any
    }
    finalize?: {
        inputCount: number
        outputCount: number
        paramsSummary?: any
    }
    cacheWrite?: { writeToCache: boolean; reason?: 'skipStore' | 'sparseFields' | 'other' }
    dataSource?: { requestId?: string; opId?: string; durationMs?: number; ok?: boolean; status?: number }
    errors?: Array<{ kind: string; code: string; message: string; traceId?: string; requestId?: string; opId?: string }>
    dataSourceRemoteExplain?: unknown
}

export type ObservabilityContext = {
    active: boolean
    traceId?: string
    requestId: () => string
    emit: (type: string, payload?: unknown, meta?: DebugEmitMeta) => void
    with: (meta: DebugEmitMeta) => ObservabilityContext
}

export type DebugEmitMeta = Partial<Pick<TraceContext, 'requestId' | 'opId'>> & {
    parentSpanId?: string
}

export type EmitFn = (type: string, payload?: unknown, meta?: DebugEmitMeta) => void

export type AtomaDebugEventMap = Record<string, unknown>

export type QueryParamsSummary = Record<string, unknown>
