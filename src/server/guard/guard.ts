import type { BatchRequest } from '../types'
import type { IOrmAdapter } from '../types'

export interface GuardOptions {
    adapter: IOrmAdapter
    allowList?: string[]
    maxQueries?: number
    maxLimit?: number
    maxBatchSize?: number
    maxPayloadBytes?: number
}

export function guardRequest(request: BatchRequest, options: GuardOptions) {
    enforceAccess(request, options)
    enforceLimits(request, options)
}

function enforceAccess(request: BatchRequest, options: GuardOptions) {
    if (request.action === 'query' && request.queries) {
        for (const q of request.queries) {
            ensureResourceAllowed(q.resource, options)
        }
        return
    }

    if (request.resource) {
        ensureResourceAllowed(request.resource, options)
    }
}

function ensureResourceAllowed(resource: string, options: GuardOptions) {
    if (options.allowList && !options.allowList.includes(resource)) {
        throw withCode('ACCESS_DENIED', `Resource access denied: ${resource}`)
    }
    if (!options.adapter.isResourceAllowed(resource)) {
        throw withCode('RESOURCE_NOT_ALLOWED', `Resource not allowed: ${resource}`)
    }
}

function enforceLimits(request: BatchRequest, options: GuardOptions) {
    if (request.action === 'query' && request.queries) {
        if (options.maxQueries && request.queries.length > options.maxQueries) {
            throw withCode('TOO_MANY_QUERIES', `Too many queries: max ${options.maxQueries}`)
        }
        for (const q of request.queries) {
            if (options.maxLimit && q.params.limit && q.params.limit > options.maxLimit) {
                q.params.limit = options.maxLimit
            }
        }
    }

    if (request.action.startsWith('bulk')) {
        const payloadArr = Array.isArray(request.payload) ? request.payload : []
        if (options.maxBatchSize && payloadArr.length > options.maxBatchSize) {
            throw withCode('TOO_MANY_ITEMS', `Too many items: max ${options.maxBatchSize}`)
        }
    }

    if (options.maxPayloadBytes && request.payload !== undefined) {
        const size = Buffer.byteLength(JSON.stringify(request.payload ?? ''), 'utf8')
        if (size > options.maxPayloadBytes) {
            throw withCode('PAYLOAD_TOO_LARGE', `Payload too large: max ${options.maxPayloadBytes} bytes`)
        }
    }
}

function withCode(code: string, message: string) {
    const err: any = new Error(message)
    err.code = code
    return err
}
