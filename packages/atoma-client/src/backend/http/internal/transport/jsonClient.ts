import type { Types } from 'atoma-core'
import { Observability } from 'atoma-observability'
import type { Envelope } from 'atoma-protocol'
import { Protocol } from 'atoma-protocol'
type DataSourceRequestEvent = {
    method: string
    endpoint: string
    attempt: number
    payloadBytes?: number
}

export type HttpInterceptors<T> = {
    onRequest?: (request: Request) => Promise<Request | void> | Request | void
    onResponse?: (context: {
        response: Response
        envelope: Envelope<T>
        request: Request
    }) => void
    responseParser?: (response: Response, data: unknown) => Promise<Envelope<T>> | Envelope<T>
}

export type ExecuteJsonArgs = {
    url: string
    endpoint: string
    method: string
    body?: unknown
    extraHeaders?: Record<string, string>
    context?: Types.ObservabilityContext
    signal?: AbortSignal
}

const hasHeader = (headers: Record<string, string>, name: string) => {
    const needle = name.toLowerCase()
    return Object.keys(headers).some(k => k.toLowerCase() === needle)
}

async function resolveRequestHeaders(
    getBaseHeaders: () => Promise<Record<string, string>>,
    extraHeaders?: Record<string, string>
): Promise<Record<string, string>> {
    const base = await getBaseHeaders()
    if (!extraHeaders) return base
    return { ...base, ...extraHeaders }
}

async function withRequestTelemetry<T>(
    ctx: Types.ObservabilityContext | undefined,
    request: Omit<DataSourceRequestEvent, 'attempt'> & { attempt?: number },
    run: (args: { startedAt: number }) => Promise<{ result: T; response?: Response; itemCount?: number }>
): Promise<T> {
    const attempt = typeof request.attempt === 'number' ? request.attempt : 1

    const shouldEmit = Boolean(ctx?.active)
    const startedAt = shouldEmit ? Date.now() : 0

    ctx?.emit('datasource:request', {
        method: request.method,
        endpoint: request.endpoint,
        attempt,
        payloadBytes: request.payloadBytes
    })

    try {
        const { result, response, itemCount } = await run({ startedAt })
        ctx?.emit('datasource:response', {
            ok: response?.ok ?? true,
            status: response?.status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined,
            itemCount
        })
        return result
    } catch (error) {
        const status = typeof (error as any)?.status === 'number'
            ? (error as any).status
            : undefined
        ctx?.emit('datasource:response', {
            ok: false,
            status,
            durationMs: shouldEmit ? (Date.now() - startedAt) : undefined
        })
        throw error
    }
}

export function createJsonHttpClient<T>(deps: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    getHeaders: () => Promise<Record<string, string>>
    interceptors?: HttpInterceptors<T>
}) {
    const execute = async (args: ExecuteJsonArgs): Promise<{ envelope: Envelope<T>; response: Response }> => {
        const ctx = args.context

        const payloadStr = args.body === undefined
            ? undefined
            : JSON.stringify(args.body)
        const payloadBytes = (payloadStr !== undefined && ctx?.active)
            ? Observability.utf8.byteLength(payloadStr)
            : undefined

        return withRequestTelemetry(
            ctx,
            {
                method: args.method,
                endpoint: args.endpoint,
                payloadBytes
            },
            async () => {
                const headers = await resolveRequestHeaders(deps.getHeaders, args.extraHeaders)
                if (payloadStr !== undefined && !hasHeader(headers, 'Content-Type')) {
                    headers['Content-Type'] = 'application/json'
                }

                let request = new Request(args.url, {
                    method: args.method,
                    headers,
                    body: payloadStr,
                    signal: args.signal
                })

                if (deps.interceptors?.onRequest) {
                    const r = await deps.interceptors.onRequest(request)
                    if (r instanceof Request) request = r
                }

                const response = await deps.fetchFn(request)

                const json = await (async () => {
                    if (response.status === 204) return null
                    try {
                        if (typeof (response as any).clone === 'function') {
                            return await response.clone().json()
                        }
                        return await response.json()
                    } catch {
                        return null
                    }
                })()

                const envelope = deps.interceptors?.responseParser
                    ? await deps.interceptors.responseParser(response, json)
                    : Protocol.ops.parse.envelope<T>(json, { v: 1 })

                deps.interceptors?.onResponse?.({
                    response,
                    envelope,
                    request
                })

                if (!envelope.ok) {
                    const code = (envelope.error && typeof envelope.error.code === 'string') ? envelope.error.code : 'unknown'
                    const message = (envelope.error && typeof envelope.error.message === 'string') ? envelope.error.message : `Error ${code}`
                    const err = new Error(message)
                    ;(err as any).status = response.status
                    ;(err as any).envelope = envelope
                    throw err
                }

                const itemCount = Array.isArray(envelope.data)
                    ? envelope.data.length
                    : (envelope.data && typeof envelope.data === 'object' && Array.isArray((envelope.data as any).results))
                        ? (envelope.data as any).results.length
                        : (envelope.data ? 1 : 0)

                return { result: { envelope, response }, response, itemCount }
            }
        )
    }

    return { execute }
}
