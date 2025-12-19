import type { BatchRequest } from '../types'
import type { IncomingHttp, ParsedOk, ParsedOutcome, ParserOptions } from './types'
import { Protocol } from '../../protocol'
import { TRACE_ID_HEADER, REQUEST_ID_HEADER } from '../../protocol/trace'

const DEFAULT_BATCH_PATH = '/batch'

export async function parseHttp(incoming: IncomingHttp, options: ParserOptions = {}): Promise<ParsedOutcome> {
    const batchPath = options.batchPath ?? DEFAULT_BATCH_PATH
    const enableRest = options.enableRest ?? true
    const traceIdHeaderName = options.traceIdHeader ?? TRACE_ID_HEADER
    const requestIdHeaderName = options.requestIdHeader ?? REQUEST_ID_HEADER

    const parsed = await Protocol.rest.parse.request(incoming, {
        batchPath,
        enableRest,
        bodyReader: options.bodyReader as any,
        traceIdHeader: traceIdHeaderName,
        requestIdHeader: requestIdHeaderName
    })

    if (parsed.ok === 'pass') return { ok: 'pass' }

    if (parsed.ok === false) {
        return { ok: false, httpStatus: parsed.status, error: parsed.error }
    }

    const urlObj = new URL(incoming.url, 'http://localhost')
    const pathname = urlObj.pathname
    const pathParts = pathname.replace(/^\/+/, '').split('/').filter(Boolean)

    const context = options.buildContext ? await options.buildContext(incoming) : {}

    const route: ParsedOk['route'] = parsed.route.kind === 'batch'
        ? { kind: 'batch', method: parsed.route.method, pathname: parsed.route.pathname }
        : {
            kind: 'rest',
            method: parsed.route.method,
            pathname: parsed.route.pathname,
            resource: parsed.route.resource ?? pathParts[0],
            id: parsed.route.id ?? pathParts[1]
        }

    return {
        ok: true,
        request: parsed.request as BatchRequest,
        context,
        route
    }
}
