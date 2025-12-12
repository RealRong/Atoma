import type { BatchRequest, BatchResponse, IOrmAdapter, StandardError } from './types'
import { parseHttp } from './parser/parseHttp'
import { guardRequest } from './guard/guard'
import { executeRequest, validateAndNormalizeRequest } from './executor/executor'
import type { ParserOptions } from './parser/types'
import type { GuardOptions } from './guard/guard'

export interface HandlerOptions {
    adapter: IOrmAdapter
    parserOptions?: ParserOptions
    guardOptions?: Omit<GuardOptions, 'adapter'>
    onSuccess?: (res: BatchResponse, req: BatchRequest, ctx: any) => Promise<void> | void
    onError?: (err: any, req: BatchRequest | undefined, ctx: any) => Promise<void> | void
}

export function createHandler(options: HandlerOptions) {
    const { adapter, parserOptions, guardOptions, onSuccess, onError } = options

    return async function handle(incoming: any): Promise<{ status: number; body: any }> {
        const parsed = await parseHttp(incoming, parserOptions)
        if (parsed.ok === 'pass') {
            return notFound()
        }
        if (parsed.ok === false) {
            return { status: parsed.httpStatus, body: { error: parsed.error } }
        }

        const ctx = parsed.context
        let request: BatchRequest | undefined

        try {
            request = validateAndNormalizeRequest(parsed.request)
            guardRequest(request, { adapter, ...(guardOptions ?? {}) })
            const response = await executeRequest(request, adapter)
            if (onSuccess) await onSuccess(response, request, ctx)
            return { status: successStatus(request), body: response }
        } catch (err: any) {
            if (onError) await onError(err, request, ctx)
            const error = toStandardError(err, 'INTERNAL')
            return { status: errorStatus(error), body: { error } }
        }
    }
}

function successStatus(req: BatchRequest) {
    if (req.action === 'delete') return 204
    if (req.action === 'create') return 201
    return 200
}

function errorStatus(error: StandardError) {
    switch (error.code) {
        case 'ACCESS_DENIED':
            return 403
        case 'RESOURCE_NOT_ALLOWED':
            return 403
        case 'TOO_MANY_QUERIES':
        case 'TOO_MANY_ITEMS':
        case 'INVALID_REQUEST':
        case 'INVALID_QUERY':
        case 'INVALID_WRITE':
        case 'INVALID_PAYLOAD':
        case 'INVALID_ORDER_BY':
            return 422
        case 'PAYLOAD_TOO_LARGE':
            return 413
        default:
            return 500
    }
}

function notFound() {
    return {
        status: 404,
        body: {
            error: {
                code: 'NOT_FOUND',
                message: 'No route matched'
            }
        }
    }
}

function toStandardError(reason: any, fallbackCode: string): StandardError {
    if (reason?.code && reason?.message) return reason as StandardError
    return {
        code: reason?.code ?? fallbackCode,
        message: reason?.message || String(reason),
        details: reason
    }
}
