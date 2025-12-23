import type { ObservabilityContext } from '#observability'
import type { Envelope } from '#protocol'
import { Protocol } from '#protocol'
import { traceFromContext } from './trace'
import type { HttpInterceptors, HttpTrace } from './pipeline'
import { createHttpJsonPipeline } from './pipeline'

export type OpsMeta = {
    v: number
    deviceId?: string
    traceId?: string
    requestId?: string
    clientTimeMs?: number
}

export type OpsRequest = {
    meta: OpsMeta
    ops: unknown[]
}

export type OpsResult<T = unknown> =
    | { opId: string; ok: true; data: T }
    | { opId: string; ok: false; error: unknown }

export type OpsResponseData<T = unknown> = {
    results: Array<OpsResult<T>>
}

export type ExecuteOpsArgs = {
    url: string
    endpoint: string
    ops: unknown[]
    extraHeaders?: Record<string, string>
    context?: ObservabilityContext
    v?: number
    deviceId?: string
    clientTimeMs?: number
}

function buildOpsMeta(args: {
    v: number
    deviceId?: string
    clientTimeMs?: number
    trace: HttpTrace
}): OpsMeta {
    return {
        v: args.v,
        ...(args.deviceId ? { deviceId: args.deviceId } : {}),
        ...(args.trace.traceId ? { traceId: args.trace.traceId } : {}),
        ...(args.trace.requestId ? { requestId: args.trace.requestId } : {}),
        ...(typeof args.clientTimeMs === 'number' ? { clientTimeMs: args.clientTimeMs } : {})
    }
}

export function createOpsTransport(deps: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    getHeaders: () => Promise<Record<string, string>>
    interceptors?: HttpInterceptors<OpsResponseData>
}) {
    const responseParser = deps.interceptors?.responseParser
        ? deps.interceptors.responseParser
        : async (_response: Response, json: unknown) => {
            const fallback = { v: 1 }
            return Protocol.ops.parse.envelope(json, fallback) as any
        }
    const pipeline = createHttpJsonPipeline<OpsResponseData>({
        fetchFn: deps.fetchFn,
        getHeaders: deps.getHeaders,
        interceptors: deps.interceptors
            ? { ...deps.interceptors, responseParser }
            : { responseParser }
    })

    const executeOps = async <T = unknown>(args: ExecuteOpsArgs): Promise<{
        envelope: Envelope<OpsResponseData<T>>
        response: Response
        results: Array<OpsResult<T>>
    }> => {
        const trace = traceFromContext(args.context)
        const meta = buildOpsMeta({
            v: args.v ?? 1,
            deviceId: args.deviceId,
            clientTimeMs: args.clientTimeMs ?? Date.now(),
            trace
        })

        const { envelope, response } = await pipeline.execute({
            url: args.url,
            endpoint: args.endpoint,
            method: 'POST',
            body: {
                meta,
                ops: args.ops
            } satisfies OpsRequest,
            extraHeaders: args.extraHeaders,
            context: trace.ctx,
            trace
        })

        const results = (envelope.ok === true && envelope.data && typeof envelope.data === 'object' && Array.isArray((envelope.data as any).results))
            ? ((envelope.data as any).results as Array<OpsResult<T>>)
            : []

        return { envelope: envelope as any, response, results }
    }

    return { executeOps }
}
