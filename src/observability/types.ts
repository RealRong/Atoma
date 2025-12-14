export type TraceContext = {
    traceId: string
    requestId?: string
    opId?: string
}

export type DebugEmitMeta = Partial<Pick<TraceContext, 'requestId' | 'opId'>> & { parentSpanId?: string }

export type FindManyParamsSummary = {
    whereFields?: string[]
    orderByFields?: string[]
    limit?: number
    offset?: number
    before?: string
    after?: string
    cursor?: string
    includeTotal?: boolean
    fields?: string[]
    skipStore?: boolean
}

export type AtomaDebugEventMap = {
    // Query (core)
    'query:start': { params: FindManyParamsSummary }
    'query:index': {
        params: { whereFields?: string[] }
        result:
            | { kind: 'unsupported' | 'empty' }
            | { kind: 'candidates'; exactness?: 'exact' | 'superset'; count: number }
        plan?: any
    }
    'query:finalize': { inputCount: number; outputCount: number; params: FindManyParamsSummary }
    'query:cacheWrite': { writeToCache: boolean; reason?: 'skipStore' | 'sparseFields' | 'other'; params: { skipStore: boolean; fields?: string[] } }

    // Mutation (core)
    'mutation:patches': { patchCount: number; inversePatchCount: number; changedFields?: string[] }
    'mutation:rollback': { reason: string }

    // Adapter / transport (HTTP + batch lanes)
    'adapter:request': {
        lane?: 'query' | 'write'
        method: string
        endpoint: string
        attempt: number
        payloadBytes?: number
        itemCount?: number
        opCount?: number
        taskCount?: number
        totalOpCount?: number
        mixedTrace?: boolean
    }
    'adapter:response': {
        lane?: 'query' | 'write'
        ok: boolean
        status?: number
        durationMs?: number
        itemCount?: number
        opCount?: number
        taskCount?: number
        totalOpCount?: number
        mixedTrace?: boolean
    }
} & Record<string, unknown>

export type DebugEmitFn<EventMap extends Record<string, any> = AtomaDebugEventMap> =
    <TType extends keyof EventMap & string>(
        type: TType,
        payload?: EventMap[TType],
        meta?: DebugEmitMeta
    ) => void

export type DebugEmitter<EventMap extends Record<string, any> = AtomaDebugEventMap> = {
    traceId: string
    emit: DebugEmitFn<EventMap>
}

/**
 * InternalOperationContext 用于在 core/adapter/batch/server 之间显式传递可观测性上下文：
 * - 禁止再通过 carrier（Symbol 挂载）从业务对象里“挖 emitter”
 * - store 通常由上层（store/adapter）补齐；对调用方可选
 */
export type InternalOperationContext = TraceContext & {
    store?: string
    emitter?: DebugEmitter
}

/**
 * Explain 是单次可复制的诊断产物：
 * - 由 core 生成并挂在 findMany 返回值上
 * - 必须可 JSON 序列化
 */
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

export type DebugOptions = {
    enabled?: boolean
    sampleRate?: number
    includePayload?: boolean
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
    store: string
    spanId: string
    parentSpanId?: string
    payload?: unknown
}
