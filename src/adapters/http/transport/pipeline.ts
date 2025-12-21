import type { ObservabilityContext } from '#observability'
import { Observability } from '#observability'
import type { StandardEnvelope } from '#protocol'
import { Protocol } from '#protocol'
import { resolveHeaders } from './headers'
import { traceFromContext } from './trace'
import { withAdapterEvents } from './events'

export type ResponseParser<T> = (
    response: Response,
    data: unknown
) => Promise<StandardEnvelope<T>> | StandardEnvelope<T>

export type HttpInterceptors<T> = {
    onRequest?: (request: Request) => Promise<Request | void> | Request | void
    onResponse?: (context: {
        response: Response
        envelope: StandardEnvelope<T>
        request: Request
    }) => void
    responseParser?: ResponseParser<T>
}

export type ExecuteJsonArgs = {
    url: string
    endpoint: string
    method: string
    body?: unknown
    extraHeaders?: Record<string, string>
    context?: ObservabilityContext
}

const hasHeader = (headers: Record<string, string>, name: string) => {
    const needle = name.toLowerCase()
    return Object.keys(headers).some(k => k.toLowerCase() === needle)
}

export function createHttpJsonPipeline<T>(deps: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    getHeaders: () => Promise<Record<string, string>>
    interceptors?: HttpInterceptors<T>
}) {
    const execute = async (args: ExecuteJsonArgs): Promise<{ envelope: StandardEnvelope<T>; response: Response }> => {
        const trace = traceFromContext(args.context)
        const ctx = trace.ctx

        const payloadStr = args.body === undefined
            ? undefined
            : JSON.stringify(args.body)
        const payloadBytes = (payloadStr !== undefined && ctx?.active)
            ? Observability.utf8.byteLength(payloadStr)
            : undefined

        return withAdapterEvents(
            ctx,
            {
                method: args.method,
                endpoint: args.endpoint,
                payloadBytes
            },
            async () => {
                const headers = await resolveHeaders(deps.getHeaders, trace.headers, args.extraHeaders)
                if (payloadStr !== undefined && !hasHeader(headers, 'Content-Type')) {
                    headers['Content-Type'] = 'application/json'
                }

                let request = new Request(args.url, {
                    method: args.method,
                    headers,
                    body: payloadStr
                })

                if (deps.interceptors?.onRequest) {
                    const r = await deps.interceptors.onRequest(request)
                    if (r instanceof Request) request = r
                }

                const response = await deps.fetchFn(request)

                const json = await (async () => {
                    if (response.status === 204) return null
                    try {
                        return await response.clone().json()
                    } catch {
                        return null
                    }
                })()

                const envelope = deps.interceptors?.responseParser
                    ? await deps.interceptors.responseParser(response, json)
                    : Protocol.http.parse.envelope<T>(response, json)

                deps.interceptors?.onResponse?.({
                    response,
                    envelope,
                    request
                })

                if (envelope.isError) {
                    const err = new Error(envelope.message || `Error ${envelope.code || 'unknown'}`)
                    ;(err as any).status = response.status
                    ;(err as any).envelope = envelope
                    throw err
                }

                const itemCount = Array.isArray(envelope.data)
                    ? envelope.data.length
                    : (envelope.data ? 1 : 0)

                return { result: { envelope, response }, response, itemCount }
            }
        )
    }

    return { execute }
}

