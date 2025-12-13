import type { BatchRequest, StandardError } from '../types'
import { restMapping } from './restMapping'
import type { BodyReader, IncomingHttp, ParsedOutcome, ParserOptions } from './types'

const DEFAULT_BATCH_PATH = '/batch'

export async function parseHttp(incoming: IncomingHttp, options: ParserOptions = {}): Promise<ParsedOutcome> {
    const batchPath = options.batchPath ?? DEFAULT_BATCH_PATH
    const enableRest = options.enableRest ?? true
    const method = (incoming.method || '').toUpperCase()

    try {
        const urlObj = new URL(incoming.url, 'http://localhost')
        const pathname = urlObj.pathname
        const context = options.buildContext ? await options.buildContext(incoming) : {}
        const traceIdHeader = getHeader(incoming.headers, 'x-atoma-trace-id')
        const requestIdHeader = getHeader(incoming.headers, 'x-atoma-request-id')

        const isBatch = method === 'POST' && normalizePath(pathname) === normalizePath(batchPath)
        if (isBatch) {
            const body = await readBody(incoming, options.bodyReader)
            if (!body || typeof body !== 'object') {
                return parseError(400, 'INVALID_BODY', 'Batch body must be a JSON object')
            }
            const traceId = traceIdHeader ?? ((body as any).traceId as any)
            const requestId = requestIdHeader ?? ((body as any).requestId as any)
            return {
                ok: true,
                request: {
                    ...(body as any),
                    ...(typeof traceId === 'string' && traceId ? { traceId } : {}),
                    ...(typeof requestId === 'string' && requestId ? { requestId } : {})
                } as BatchRequest,
                context,
                route: {
                    kind: 'batch',
                    method,
                    pathname
                }
            }
        }

        if (!enableRest) {
            return { ok: 'pass' }
        }

        const bodyNeeded = method !== 'GET' && method !== 'HEAD'
        const body = bodyNeeded ? await readBody(incoming, options.bodyReader) : undefined
        const pathParts = pathname.replace(/^\/+/, '').split('/').filter(Boolean)
        const mapped = restMapping({ method, pathParts, searchParams: urlObj.searchParams, body })
        if (!mapped) {
            return { ok: 'pass' }
        }
        if (typeof traceIdHeader === 'string' && traceIdHeader) (mapped as any).traceId = traceIdHeader
        if (typeof requestIdHeader === 'string' && requestIdHeader) (mapped as any).requestId = requestIdHeader
        return {
            ok: true,
            request: mapped,
            context,
            route: {
                kind: 'rest',
                method,
                pathname,
                resource: pathParts[0],
                id: pathParts[1]
            }
        }
    } catch (err: any) {
        return parseError(400, 'BAD_REQUEST', err?.message || 'Invalid request')
    }
}

function normalizePath(path: string) {
    return path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path
}

function getHeader(headers: IncomingHttp['headers'] | undefined, name: string): string | undefined {
    if (!headers) return undefined
    const direct = headers[name]
    if (typeof direct === 'string') return direct
    const lower = headers[name.toLowerCase()]
    if (typeof lower === 'string') return lower
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase())
    if (!key) return undefined
    const v = headers[key]
    return typeof v === 'string' ? v : undefined
}

async function readBody(incoming: IncomingHttp, bodyReader?: BodyReader) {
    if (bodyReader) return bodyReader(incoming)
    if (typeof incoming.json === 'function') {
        return incoming.json()
    }
    if (incoming.body !== undefined) return incoming.body
    if (typeof incoming.text === 'function') {
        const txt = await incoming.text()
        if (!txt) return undefined
        return JSON.parse(txt)
    }
    return undefined
}

function parseError(httpStatus: number, code: string, message: string): ParsedOutcome {
    const error: StandardError = { code, message, details: { kind: 'validation' } }
    return { ok: false, httpStatus, error }
}
