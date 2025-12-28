import type { TraceContext } from './public'

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

    // DataSource / transport (HTTP + batch lanes)
    'datasource:request': {
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
    'datasource:response': {
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

export type EmitFn<EventMap extends Record<string, any> = AtomaDebugEventMap> =
    <TType extends keyof EventMap & string>(
        type: TType,
        data?: EventMap[TType],
        meta?: DebugEmitMeta
    ) => void
