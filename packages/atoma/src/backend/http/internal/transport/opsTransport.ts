import type { ObservabilityContext } from '#observability'
import type { Envelope, Meta, Operation } from '#protocol'
import { Protocol } from '#protocol'
import type { OpsResponseData } from '#protocol'
import type { HttpInterceptors } from './jsonClient'
import { createJsonHttpClient } from './jsonClient'

export type ExecuteOpsArgs = {
    baseURL: string
    opsPath: string
    ops: Operation[]
    meta: Meta
    extraHeaders?: Record<string, string>
    context?: ObservabilityContext
    signal?: AbortSignal
}

function joinUrl(base: string, path: string): string {
    if (!base) return path
    if (!path) return base

    const hasTrailing = base.endsWith('/')
    const hasLeading = path.startsWith('/')

    if (hasTrailing && hasLeading) return `${base}${path.slice(1)}`
    if (!hasTrailing && !hasLeading) return `${base}/${path}`
    return `${base}${path}`
}

export function createOpsHttpTransport(deps: {
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

    const pipeline = createJsonHttpClient<OpsResponseData>({
        fetchFn: deps.fetchFn,
        getHeaders: deps.getHeaders,
        interceptors: deps.interceptors
            ? { ...deps.interceptors, responseParser }
            : { responseParser }
    })

    const executeOps = async (args: ExecuteOpsArgs): Promise<{
        envelope: Envelope<OpsResponseData>
        response: Response
        results: OpsResponseData['results']
    }> => {
        const { envelope, response } = await pipeline.execute({
            url: joinUrl(args.baseURL, args.opsPath),
            endpoint: args.opsPath,
            method: 'POST',
            body: {
                meta: args.meta,
                ops: args.ops
            } satisfies { meta: Meta; ops: Operation[] },
            extraHeaders: args.extraHeaders,
            context: args.context,
            signal: args.signal
        })

        const results = (envelope.ok === true && envelope.data && typeof envelope.data === 'object' && Array.isArray((envelope.data as any).results))
            ? ((envelope.data as any).results as OpsResponseData['results'])
            : []

        return { envelope: envelope as any, response, results }
    }

    return { executeOps }
}

