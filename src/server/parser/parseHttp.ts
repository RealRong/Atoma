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

        const isBatch = method === 'POST' && normalizePath(pathname) === normalizePath(batchPath)
        if (isBatch) {
            const body = await readBody(incoming, options.bodyReader)
            if (!body || typeof body !== 'object') {
                return parseError(400, 'INVALID_BODY', 'Batch body must be a JSON object')
            }
            return { ok: true, request: body as BatchRequest, context }
        }

        if (!enableRest) {
            return { ok: 'pass' }
        }

        const bodyNeeded = method !== 'GET' && method !== 'HEAD'
        const body = bodyNeeded ? await readBody(incoming, options.bodyReader) : undefined
        const pathParts = pathname.replace(/^\/+/, '').split('/')
        const mapped = restMapping({ method, pathParts, searchParams: urlObj.searchParams, body })
        if (!mapped) {
            return { ok: 'pass' }
        }
        return { ok: true, request: mapped, context }
    } catch (err: any) {
        return parseError(400, 'BAD_REQUEST', err?.message || 'Invalid request')
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

function parseError(httpStatus: number, code: string, message: string): ParsedOutcome {
    const error: StandardError = { code, message }
    return { ok: false, httpStatus, error }
}
