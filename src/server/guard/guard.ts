import type { BatchRequest } from '../types'
import type { IOrmAdapter } from '../types'
import type { FieldPolicyInput } from './fieldPolicy'
import { enforceQueryFieldPolicy, resolveFieldPolicy } from './fieldPolicy'
import { throwError } from '../error'

export interface GuardOptions {
    adapter: IOrmAdapter
    allowList?: string[]
    maxQueries?: number
    maxLimit?: number
    maxBatchSize?: number
    maxPayloadBytes?: number
    policy?: FieldPolicyInput
}

export function guardRequest(request: BatchRequest, options: GuardOptions, meta?: { ctx?: any }) {
    enforceAccess(request, options, meta)
    enforceFieldPolicy(request, options, meta)
    enforceLimits(request, options, meta)
}

function enforceAccess(request: BatchRequest, options: GuardOptions, meta?: { ctx?: any }) {
    for (const op of request.ops) {
        const resource = op.action === 'query'
            ? op.query.resource
            : (op as any).resource
        if (typeof resource === 'string' && resource) {
            ensureResourceAllowed(resource, options, {
                traceId: (request as any).traceId,
                requestId: (request as any).requestId
            })
        }
    }
}

function enforceFieldPolicy(request: BatchRequest, options: GuardOptions, meta?: { ctx?: any }) {
    if (!options.policy) return

    const queryOps = request.ops.filter(op => op.action === 'query')
    for (let i = 0; i < queryOps.length; i++) {
        const op = queryOps[i]
        const policy = resolveFieldPolicy(options.policy, {
            action: op.action,
            resource: op.query.resource,
            params: op.query.params,
            ctx: meta?.ctx,
            request,
            queryIndex: i
        })
        if (!policy) continue
        enforceQueryFieldPolicy(op.query.resource, op.query.params, policy, {
            queryIndex: i,
            traceId: (request as any).traceId,
            requestId: (request as any).requestId,
            opId: op.opId
        })
    }
}

function ensureResourceAllowed(resource: string, options: GuardOptions, meta?: { traceId?: string; requestId?: string }) {
    if (options.allowList && !options.allowList.includes(resource)) {
        throwError('ACCESS_DENIED', `Resource access denied: ${resource}`, { kind: 'access', resource, ...meta })
    }
    if (!options.adapter.isResourceAllowed(resource)) {
        throwError('RESOURCE_NOT_ALLOWED', `Resource not allowed: ${resource}`, { kind: 'access', resource, ...meta })
    }
}

function enforceLimits(request: BatchRequest, options: GuardOptions, _meta?: { ctx?: any }) {
    const queryOps = request.ops.filter(op => op.action === 'query')
    const traceMeta = { traceId: (request as any).traceId, requestId: (request as any).requestId }

    if (options.maxQueries && queryOps.length > options.maxQueries) {
        throwError('TOO_MANY_QUERIES', `Too many queries: max ${options.maxQueries}`, {
            kind: 'limits',
            max: options.maxQueries,
            actual: queryOps.length,
            ...traceMeta
        })
    }

    if (options.maxLimit) {
        for (const op of queryOps) {
            const page = (op.query.params as any).page
            if (!page || typeof page !== 'object') continue
            if (page.mode === 'offset' || page.mode === 'cursor') {
                if (typeof page.limit === 'number' && page.limit > options.maxLimit) {
                    page.limit = options.maxLimit
                }
            }
        }
    }

    for (const op of request.ops) {
        if (op.action === 'query') continue

        const payloadArr = Array.isArray((op as any).payload) ? (op as any).payload : []
        if (options.maxBatchSize && payloadArr.length > options.maxBatchSize) {
            throwError('TOO_MANY_ITEMS', `Too many items: max ${options.maxBatchSize}`, {
                kind: 'limits',
                max: options.maxBatchSize,
                actual: payloadArr.length,
                ...traceMeta
            })
        }

        if (options.maxPayloadBytes && (op as any).payload !== undefined) {
            const size = Buffer.byteLength(JSON.stringify((op as any).payload ?? ''), 'utf8')
            if (size > options.maxPayloadBytes) {
                throwError('PAYLOAD_TOO_LARGE', `Payload too large: max ${options.maxPayloadBytes} bytes`, {
                    kind: 'limits',
                    max: options.maxPayloadBytes,
                    actual: size,
                    ...traceMeta
                })
            }
        }
    }
}
