import type { Envelope, Meta, RemoteOp, RemoteOpsResponseData } from 'atoma-types/protocol'
import { parseEnvelope } from 'atoma-types/protocol-tools'
import { requestJson } from 'atoma-shared'
import type { RetryOptions } from 'atoma-shared'

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

export function createTransport(deps: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    retry?: RetryOptions
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
        const { response, request, payload } = await requestJson({
            baseURL: args.baseURL,
            path: args.endpointPath,
            fetchFn: deps.fetchFn,
            retry: deps.retry,
            headers: deps.getHeaders,
            extraHeaders: args.extraHeaders,
            method: 'POST',
            body: {
                meta: args.meta,
                ops: args.ops
            } satisfies { meta: Meta; ops: RemoteOp[] },
            signal: args.signal,
            defaultContentType: 'application/json',
            jsonMode: 'loose',
            emptyJsonValue: null,
            preserveResponseBody: true,
            onRequest: deps.interceptors?.onRequest
        })
        const envelope = await responseParser(response, payload)

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
