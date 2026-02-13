import type { Envelope, Meta, RemoteOp } from 'atoma-types/protocol'
import { parseEnvelope } from 'atoma-types/protocol-tools'
import type { RemoteOpsResponseData } from 'atoma-types/protocol'
import type { HttpInterceptors } from './json-client'
import { createJsonHttpClient } from './json-client'

export type ExecuteOperationRequest = {
    baseURL: string
    endpointPath: string
    ops: RemoteOp[]
    meta: Meta
    extraHeaders?: Record<string, string>
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

export function createOperationHttpTransport(deps: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    getHeaders: () => Promise<Record<string, string>>
    interceptors?: HttpInterceptors<RemoteOpsResponseData>
}) {
    const responseParser = deps.interceptors?.responseParser
        ? deps.interceptors.responseParser
        : async (_response: Response, json: unknown) => {
            const fallback = { v: 1 }
            return parseEnvelope(json, fallback) as any
        }

    const pipeline = createJsonHttpClient<RemoteOpsResponseData>({
        fetchFn: deps.fetchFn,
        getHeaders: deps.getHeaders,
        interceptors: deps.interceptors
            ? { ...deps.interceptors, responseParser }
            : { responseParser }
    })

    const executeOperations = async (args: ExecuteOperationRequest): Promise<{
        envelope: Envelope<RemoteOpsResponseData>
        response: Response
        results: RemoteOpsResponseData['results']
    }> => {
        const { envelope, response } = await pipeline.execute({
            url: joinUrl(args.baseURL, args.endpointPath),
            endpoint: args.endpointPath,
            method: 'POST',
            body: {
                meta: args.meta,
                ops: args.ops
            } satisfies { meta: Meta; ops: RemoteOp[] },
            extraHeaders: args.extraHeaders,
            signal: args.signal
        })

        const results = (envelope.ok === true && envelope.data && typeof envelope.data === 'object' && Array.isArray((envelope.data as any).results))
            ? ((envelope.data as any).results as RemoteOpsResponseData['results'])
            : []

        return { envelope: envelope as any, response, results }
    }

    return { executeOperations }
}
