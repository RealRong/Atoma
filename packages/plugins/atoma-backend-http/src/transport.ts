import type { Envelope, Meta, RemoteOp, RemoteOpsResponseData } from 'atoma-types/protocol'
import { parseEnvelope } from 'atoma-types/protocol-tools'

export type HttpInterceptors<T> = {
    onRequest?: (request: Request) => Promise<Request | void> | Request | void
    onResponse?: (context: {
        response: Response
        envelope: Envelope<T>
        request: Request
    }) => void
    responseParser?: (response: Response, data: unknown) => Promise<Envelope<T>> | Envelope<T>
}

export type ExecuteOperationRequest = {
    baseURL: string
    endpointPath: string
    ops: RemoteOp[]
    meta: Meta
    extraHeaders?: Record<string, string>
    signal?: AbortSignal
}

const hasHeader = (headers: Record<string, string>, name: string): boolean => {
    const needle = name.toLowerCase()
    return Object.keys(headers).some((key) => key.toLowerCase() === needle)
}

async function resolveHeaders(
    getBaseHeaders: () => Promise<Record<string, string>>,
    extraHeaders?: Record<string, string>
): Promise<Record<string, string>> {
    const baseHeaders = await getBaseHeaders()
    return extraHeaders ? { ...baseHeaders, ...extraHeaders } : baseHeaders
}

async function parseResponseJson(response: Response): Promise<unknown> {
    if (response.status === 204) return null

    try {
        if (typeof (response as { clone?: () => Response }).clone === 'function') {
            return await response.clone().json()
        }
        return await response.json()
    } catch {
        return null
    }
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

export function createTransport(deps: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    getHeaders: () => Promise<Record<string, string>>
    interceptors?: HttpInterceptors<RemoteOpsResponseData>
}) {
    const responseParser = deps.interceptors?.responseParser
        ? deps.interceptors.responseParser
        : async (_response: Response, json: unknown) => parseEnvelope<RemoteOpsResponseData>(json, { v: 1 })

    const executeOperations = async (args: ExecuteOperationRequest): Promise<{
        envelope: Envelope<RemoteOpsResponseData>
        response: Response
        results: RemoteOpsResponseData['results']
    }> => {
        const headers = await resolveHeaders(deps.getHeaders, args.extraHeaders)
        if (!hasHeader(headers, 'Content-Type')) {
            headers['Content-Type'] = 'application/json'
        }

        let request = new Request(joinUrl(args.baseURL, args.endpointPath), {
            method: 'POST',
            headers,
            body: JSON.stringify({
                meta: args.meta,
                ops: args.ops
            } satisfies { meta: Meta; ops: RemoteOp[] }),
            signal: args.signal
        })

        if (deps.interceptors?.onRequest) {
            const nextRequest = await deps.interceptors.onRequest(request)
            if (nextRequest instanceof Request) request = nextRequest
        }

        const response = await deps.fetchFn(request)
        const envelope = await responseParser(response, await parseResponseJson(response))

        deps.interceptors?.onResponse?.({
            response,
            envelope,
            request
        })

        if (!envelope.ok) {
            const code = (envelope.error && typeof envelope.error.code === 'string') ? envelope.error.code : 'unknown'
            const message = (envelope.error && typeof envelope.error.message === 'string') ? envelope.error.message : `Error ${code}`
            const error = new Error(message)
                ; (error as { status?: number }).status = response.status
                ; (error as { envelope?: Envelope<RemoteOpsResponseData> }).envelope = envelope
            throw error
        }

        const results = (envelope.data && typeof envelope.data === 'object' && Array.isArray((envelope.data as { results?: unknown }).results))
            ? ((envelope.data as { results: RemoteOpsResponseData['results'] }).results)
            : []

        return { envelope, response, results }
    }

    return { executeOperations }
}
