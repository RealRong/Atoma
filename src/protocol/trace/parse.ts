import type { HeadersLike } from './types'

export function getHeader(headers: HeadersLike, name: string): string | undefined {
    if (!headers) return undefined
    if (typeof (headers as any).get === 'function') {
        const v = (headers as any).get(name)
        return typeof v === 'string' ? v : undefined
    }
    const h = headers as Record<string, string>
    const direct = h[name]
    if (typeof direct === 'string') return direct
    const lower = h[name.toLowerCase()]
    if (typeof lower === 'string') return lower
    const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase())
    if (!key) return undefined
    const v = h[key]
    return typeof v === 'string' ? v : undefined
}

export function getTraceId(headers: HeadersLike, traceIdHeader: string): string | undefined {
    const v = getHeader(headers, traceIdHeader)
    return typeof v === 'string' && v ? v : undefined
}

export function getRequestId(headers: HeadersLike, requestIdHeader: string): string | undefined {
    const v = getHeader(headers, requestIdHeader)
    return typeof v === 'string' && v ? v : undefined
}
