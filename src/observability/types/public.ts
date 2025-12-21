export type TraceContext = {
    traceId: string
    requestId?: string
    opId?: string
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
    adapter?: { requestId?: string; opId?: string; durationMs?: number; ok?: boolean; status?: number }
    errors?: Array<{ kind: string; code: string; message: string; traceId?: string; requestId?: string; opId?: string }>
    adapterRemoteExplain?: unknown
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
