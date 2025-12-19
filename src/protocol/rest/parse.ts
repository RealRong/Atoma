import type { BatchRequest } from '../batch/types'
import { create as createError } from '../error/fns'
import { restMapping } from './mapping'
import { TRACE_ID_HEADER, REQUEST_ID_HEADER } from '../trace/constants'
import { getHeader } from '../trace/parse'
import type { BodyReader, IncomingHttp, ParseOptions, ParseOutcome, RestRoute } from './types'

const DEFAULT_BATCH_PATH = '/batch'

export async function parseHttp(incoming: IncomingHttp, options: ParseOptions = {}): Promise<ParseOutcome> {
    const batchPath = options.batchPath ?? DEFAULT_BATCH_PATH
    const enableRest = options.enableRest ?? true
    const traceIdHeaderName = options.traceIdHeader ?? TRACE_ID_HEADER
    const requestIdHeaderName = options.requestIdHeader ?? REQUEST_ID_HEADER
    const method = (incoming.method || '').toUpperCase()

    try {
        const urlObj = new URL(incoming.url, 'http://localhost')
        const pathname = urlObj.pathname
        const traceIdHeader = getHeader(incoming.headers, traceIdHeaderName)
        const requestIdHeader = getHeader(incoming.headers, requestIdHeaderName)

        const isBatch = method === 'POST' && normalizePath(pathname) === normalizePath(batchPath)
        if (isBatch) {
            const body = await readBody(incoming, options.bodyReader)
            if (!body || typeof body !== 'object') {
                return parseError(400, 'INVALID_BODY', 'Batch body must be a JSON object')
            }
            const traceId = traceIdHeader ?? ((body as any).traceId as any)
            const requestId = requestIdHeader ?? ((body as any).requestId as any)
            const merged = {
                ...(body as any),
                ...(typeof traceId === 'string' && traceId ? { traceId } : {}),
                ...(typeof requestId === 'string' && requestId ? { requestId } : {})
            } as BatchRequest

            return okOutcome({ request: merged, route: { kind: 'batch', method, pathname } })
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

        return okOutcome({
            request: mapped,
            route: { kind: 'rest', method, pathname, resource: pathParts[0], id: pathParts[1] }
        })
    } catch (e: any) {
        return parseError(400, 'BAD_REQUEST', e?.message || 'Invalid request')
    }
}

function normalizePath(path: string) {
    return path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path
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

function parseError(status: number, code: string, message: string): ParseOutcome {
    return { ok: false, status, error: createError(code, message, { kind: 'validation' }) }
}

function okOutcome(value: { request: BatchRequest; route: RestRoute }): Extract<ParseOutcome, { ok: true }> {
    return { ok: true, ...value }
}
