import type { FetchFn } from './types'

type HeadersResolver = () => Promise<Record<string, string>> | Record<string, string>

export async function resolveHeaders(headers?: HeadersResolver): Promise<Record<string, string>> {
    if (!headers) return {}
    const h = headers()
    return h instanceof Promise ? await h : h
}

export async function sendBatchRequest(
    fetcher: FetchFn,
    endpoint: string,
    headers: HeadersResolver | undefined,
    payload: any,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>
) {
    const resolvedHeaders = await resolveHeaders(headers)
    const response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...resolvedHeaders,
            ...(extraHeaders || {})
        },
        body: JSON.stringify(payload),
        signal
    })

    if (!response.ok) {
        const err: any = new Error(`Batch request failed: ${response.status} ${response.statusText}`)
        err.status = response.status
        throw err
    }

    return { json: await response.json(), status: response.status }
}

