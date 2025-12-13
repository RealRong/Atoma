import type { BatchRequest, BatchResponse, IOrmAdapter, StandardError } from './types'
import { parseHttp } from './parser/parseHttp'
import { guardRequest } from './guard/guard'
import { executeRequest } from './executor/executor'
import { validateAndNormalizeRequest } from './validator/validator'
import { errorStatus, toStandardError } from './error'
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
            guardRequest(request, { adapter, ...(guardOptions ?? {}) }, { ctx })
            const response = await executeRequest(request, adapter)
            if (onSuccess) await onSuccess(response, request, ctx)
            if (parsed.route.kind === 'rest') {
                return toRestResponse(parsed.route, request, response)
            }
            return { status: 200, body: response }
        } catch (err: any) {
            if (onError) await onError(err, request, ctx)
            const error = toStandardError(err, 'INTERNAL')
            return { status: errorStatus(error), body: { error } }
        }
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

function toRestResponse(
    route: { kind: 'rest'; id?: string; method: string },
    req: BatchRequest,
    res: BatchResponse
): { status: number; body: any } {
    const first = Array.isArray(res.results) ? res.results[0] : undefined
    if (!first) {
        return { status: 500, body: { error: { code: 'INTERNAL', message: 'Empty result' } } }
    }

    if (first.ok === false || first.error) {
        const error = (first.error as StandardError) ?? { code: 'INTERNAL', message: 'Internal error' }
        return { status: errorStatus(error), body: { error } }
    }

    const method = (route.method || '').toUpperCase()

    if (method === 'GET') {
        if (route.id !== undefined) {
            const item = Array.isArray(first.data) ? first.data[0] : undefined
            if (!item) {
                return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } }
            }
            return { status: 200, body: { data: item } }
        }
        return { status: 200, body: { data: first.data ?? [], pageInfo: first.pageInfo } }
    }

    if (method === 'DELETE') {
        if (Array.isArray(first.partialFailures) && first.partialFailures.length) {
            const error = first.partialFailures[0].error as StandardError
            return { status: errorStatus(error), body: { error } }
        }
        return { status: 204, body: undefined }
    }

    if (Array.isArray(first.partialFailures) && first.partialFailures.length) {
        const error = first.partialFailures[0].error as StandardError
        return { status: errorStatus(error), body: { error } }
    }

    const item = Array.isArray(first.data) ? first.data[0] : undefined
    const status = method === 'POST' ? 201 : 200
    return { status, body: { data: item ?? null } }
}

// toStandardError/errorStatus moved to src/server/error.ts
