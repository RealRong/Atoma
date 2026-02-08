import type { Envelope } from 'atoma-types/protocol'
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

export type ExecuteJsonArgs = {
    url: string
    endpoint: string
    method: string
    body?: unknown
    extraHeaders?: Record<string, string>
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

export function createJsonHttpClient<T>(deps: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    getHeaders: () => Promise<Record<string, string>>
    interceptors?: HttpInterceptors<T>
}) {
    const execute = async (args: ExecuteJsonArgs): Promise<{ envelope: Envelope<T>; response: Response }> => {
        const payloadStr = args.body === undefined
            ? undefined
            : JSON.stringify(args.body)
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
            : parseEnvelope<T>(json, { v: 1 })

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

        return { envelope, response }
    }

    return { execute }
}
