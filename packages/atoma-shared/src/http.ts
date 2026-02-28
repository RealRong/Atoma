import { isRecord } from './record'
import { fetchWithRetry, type RetryOptions } from './retry'

export function hasHeader(headers: Record<string, string>, name: string): boolean {
    const needle = name.toLowerCase()
    return Object.keys(headers).some((key) => key.toLowerCase() === needle)
}

export function joinUrl(base: string, path: string): string {
    if (!base) return path
    if (!path) return base

    const hasTrailing = base.endsWith('/')
    const hasLeading = path.startsWith('/')

    if (hasTrailing && hasLeading) return `${base}${path.slice(1)}`
    if (!hasTrailing && !hasLeading) return `${base}/${path}`
    return `${base}${path}`
}

type HeaderInput = Record<string, unknown> | undefined | null

export type HeaderProvider = (() => Promise<HeaderInput> | HeaderInput) | undefined

export type JsonRequestOptions = Readonly<{
    baseURL: string
    path: string
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    headers?: HeaderProvider
    extraHeaders?: Record<string, string>
    retry?: RetryOptions
    onRequest?: (request: Request) => Promise<Request | void> | Request | void
    method?: string
    body?: unknown
    signal?: AbortSignal
    defaultContentType?: string
    jsonMode?: 'strict' | 'loose'
    emptyJsonValue?: unknown
    invalidJsonMessage?: string
    preserveResponseBody?: boolean
}>

export async function requestJson(args: JsonRequestOptions): Promise<{
    request: Request
    response: Response
    payload: unknown
}> {
    const headers = await resolveHeaders(args.headers, args.extraHeaders)
    if (args.defaultContentType && !hasHeader(headers, 'content-type')) {
        headers['content-type'] = args.defaultContentType
    }

    let request = new Request(joinUrl(args.baseURL, args.path), {
        method: args.method ?? 'POST',
        headers,
        ...(args.body === undefined
            ? {}
            : {
                body: JSON.stringify(args.body)
            }),
        ...(args.signal
            ? {
                signal: args.signal
            }
            : {})
    })

    if (typeof args.onRequest === 'function') {
        const nextRequest = await args.onRequest(request)
        if (nextRequest instanceof Request) {
            request = nextRequest
        }
    }

    const response = await fetchWithRetry({
        fetchFn: args.fetchFn,
        input: request,
        retry: args.retry
    })
    const payload = await parseJsonResponse({
        response,
        mode: args.jsonMode ?? 'strict',
        emptyValue: args.emptyJsonValue,
        invalidJsonMessage: args.invalidJsonMessage,
        preserveResponseBody: args.preserveResponseBody !== false
    })

    return {
        request,
        response,
        payload
    }
}

async function resolveHeaders(
    provider: HeaderProvider,
    extraHeaders: Record<string, string> | undefined
): Promise<Record<string, string>> {
    const baseHeaders = normalizeHeaders(provider ? await provider() : undefined)
    return extraHeaders
        ? { ...baseHeaders, ...extraHeaders }
        : baseHeaders
}

function normalizeHeaders(input: HeaderInput): Record<string, string> {
    if (!isRecord(input)) return {}
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(input)) {
        if (!key) continue
        if (value === undefined || value === null) continue
        headers[key] = String(value)
    }
    return headers
}

async function parseJsonResponse(args: {
    response: Response
    mode: 'strict' | 'loose'
    emptyValue: unknown
    invalidJsonMessage?: string
    preserveResponseBody: boolean
}): Promise<unknown> {
    if (args.response.status === 204) return args.emptyValue

    const reader = args.preserveResponseBody && typeof args.response.clone === 'function'
        ? args.response.clone()
        : args.response
    const text = await reader.text()
    if (!text.trim()) return args.emptyValue

    try {
        return JSON.parse(text)
    } catch {
        if (args.mode === 'loose') return args.emptyValue
        throw new Error(args.invalidJsonMessage ?? '[HTTP] response body is not valid JSON')
    }
}
