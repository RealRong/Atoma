import lodash from 'lodash'
import type {
    Action,
    BatchRequest,
    BatchResponse,
    BatchResult,
    IOrmAdapter,
    QueryParams,
    QueryResult,
    QueryResultMany,
    QueryResultOne,
    StandardError
} from '../types'

export async function executeRequest(request: BatchRequest, adapter: IOrmAdapter): Promise<BatchResponse> {
    if (request.action === 'query') {
        return handleQuery(request, adapter)
    }
    return handleWrite(request, adapter)
}

async function handleQuery(request: BatchRequest, adapter: IOrmAdapter): Promise<BatchResponse> {
    if (!request.queries) {
        throw withCode('INVALID_QUERY', 'Invalid query payload')
    }

    if (adapter.batchFindMany) {
        const results = await adapter.batchFindMany(
            request.queries.map(q => ({ resource: q.resource, params: q.params }))
        )
        return { results: mergeIds(request, results) }
    }

    const settled = await Promise.allSettled(
        request.queries.map(q => adapter.findMany(q.resource, q.params))
    )

    const results: BatchResult[] = settled.map((res, idx) => {
        const requestId = request.queries?.[idx]?.requestId
        if (res.status === 'fulfilled') {
            return { requestId, data: res.value.data, pageInfo: res.value.pageInfo }
        }
        return toErrorResult(requestId, res.reason, 'QUERY_FAILED')
    })

    return { results }
}

async function handleWrite(request: BatchRequest, adapter: IOrmAdapter): Promise<BatchResponse> {
    const resource = request.resource as string
    const payload = request.payload
    const options = request.options
    const action = request.action

    let result: BatchResult
    switch (action) {
        case 'create': {
            ensureAdapter(adapter.create, action)
            const res = await adapter.create!(resource, payload, options)
            result = wrapOne(res, request.requestId)
            break
        }
        case 'update': {
            ensureAdapter(adapter.update, action)
            const res = await adapter.update!(resource, payload, { ...options, where: request.where })
            result = wrapOne(res, request.requestId)
            break
        }
        case 'patch': {
            ensureAdapter(adapter.patch, action)
            const res = await adapter.patch!(resource, payload, options)
            result = wrapOne(res, request.requestId)
            break
        }
        case 'delete': {
            ensureAdapter(adapter.delete, action)
            const res = await adapter.delete!(resource, payload ?? request.where, options)
            result = wrapOne(res, request.requestId)
            break
        }
        case 'bulkCreate': {
            ensureAdapter(adapter.bulkCreate, action)
            const res = await adapter.bulkCreate!(resource, ensureArray(payload, action), options)
            result = wrapMany(res, request.requestId)
            break
        }
        case 'bulkUpdate': {
            ensureAdapter(adapter.bulkUpdate, action)
            const res = await adapter.bulkUpdate!(resource, ensureArray(payload, action), options)
            result = wrapMany(res, request.requestId)
            break
        }
        case 'bulkPatch': {
            ensureAdapter(adapter.bulkPatch, action)
            const res = await adapter.bulkPatch!(resource, ensureArray(payload, action), options)
            result = wrapMany(res, request.requestId)
            break
        }
        case 'bulkDelete': {
            ensureAdapter(adapter.bulkDelete, action)
            const res = await adapter.bulkDelete!(resource, ensureArray(payload, action), options)
            result = wrapMany(res, request.requestId)
            break
        }
        default:
            throw withCode('UNSUPPORTED_ACTION', `Unsupported action: ${action}`)
    }

    return { results: [result] }
}

function mergeIds(request: BatchRequest, results: QueryResult[]): BatchResult[] {
    return results.map((result, idx) => ({
        requestId: request.queries?.[idx]?.requestId,
        data: result.data,
        pageInfo: result.pageInfo
    }))
}

function ensureAdapter(fn: unknown, action: Action) {
    if (typeof fn !== 'function') {
        throw withCode('ADAPTER_NOT_IMPLEMENTED', `Adapter does not implement ${action}`)
    }
}

function wrapOne(result: QueryResultOne, requestId?: string): BatchResult {
    if (result.error) {
        return toErrorResult(requestId, result.error, result.error.code)
    }
    return {
        requestId,
        data: result.data !== undefined ? [result.data] : [],
        transactionApplied: result.transactionApplied
    }
}

function wrapMany(result: QueryResultMany, requestId?: string): BatchResult {
    return {
        requestId,
        data: result.data,
        partialFailures: result.partialFailures,
        transactionApplied: result.transactionApplied,
        error: result.partialFailures && result.partialFailures.length
            ? { code: 'PARTIAL_FAILURE', message: 'Some items failed', details: result.partialFailures }
            : undefined
    }
}

function ensureArray(payload: any, action: Action): any[] {
    if (Array.isArray(payload)) return payload
    throw withCode('INVALID_PAYLOAD', `Payload for ${action} must be an array`)
}

export function validateAndNormalizeRequest(body: any): BatchRequest {
    if (!body || typeof body.action !== 'string') {
        throw withCode('INVALID_REQUEST', 'Invalid Atoma request payload')
    }

    const action = body.action as Action

    if (action === 'query') {
        if (!Array.isArray(body.queries)) {
            throw withCode('INVALID_QUERY', 'Invalid query payload: queries missing')
        }
        const queries = body.queries.map((q: any) => {
            if (!q || typeof q.resource !== 'string') {
                throw withCode('INVALID_QUERY', 'Invalid query: resource missing')
            }
            const params: QueryParams = lodash.isPlainObject(q.params) ? { ...q.params } : {}
            params.orderBy = normalizeOrderBy(params.orderBy)
            return {
                resource: q.resource,
                requestId: q.requestId,
                params
            }
        })
        return { action, queries }
    }

    if (!body.resource || typeof body.resource !== 'string') {
        throw withCode('INVALID_WRITE', 'Invalid write payload: resource missing')
    }

    return {
        action,
        resource: body.resource,
        payload: body.payload,
        where: lodash.isPlainObject(body.where) ? body.where : undefined,
        options: lodash.isPlainObject(body.options) ? body.options : undefined,
        requestId: body.requestId
    }
}

function normalizeOrderBy(orderBy: QueryParams['orderBy']): QueryParams['orderBy'] {
    if (!orderBy) return undefined

    const normalizeOne = (rule: any) => {
        if (typeof rule === 'string') {
            const [field, dir] = rule.split(':')
            if (!field) throw withCode('INVALID_ORDER_BY', 'Invalid orderBy')
            const direction = dir?.toLowerCase() === 'asc' ? 'asc' : 'desc'
            return { field, direction }
        }
        if (rule && typeof rule === 'object' && typeof (rule as any).field === 'string') {
            const direction = (rule as any).direction === 'asc' ? 'asc' : 'desc'
            return { field: (rule as any).field, direction }
        }
        throw withCode('INVALID_ORDER_BY', 'Invalid orderBy')
    }

    if (Array.isArray(orderBy)) return orderBy.map(normalizeOne)
    return [normalizeOne(orderBy)]
}

function toErrorResult(requestId: string | undefined, reason: any, code = 'INTERNAL'): BatchResult {
    return {
        requestId,
        data: [],
        error: toStandardError(reason, code)
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

function withCode(code: string, message: string) {
    const err: any = new Error(message)
    err.code = code
    return err
}
