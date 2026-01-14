import type { QueryParams } from '../../query'
import { assertFiniteNumber, invalid, isObject, isPlainObject } from './common'

export function assertQueryParams(value: unknown, ctx: { opId: string; resource: string }): QueryParams {
    if (!isObject(value)) throw invalid('INVALID_REQUEST', 'Missing query.params', { kind: 'validation', part: 'query', opId: ctx.opId, resource: ctx.resource })
    const params = value as QueryParams

    const where = (params as any).where
    if (where !== undefined && !isPlainObject(where)) {
        throw invalid('INVALID_QUERY', 'Invalid where (must be a plain object)', { kind: 'validation', part: 'query', field: 'where', opId: ctx.opId, resource: ctx.resource })
    }

    const orderBy = (params as any).orderBy
    if (orderBy !== undefined) {
        const arr = Array.isArray(orderBy) ? orderBy : [orderBy]
        if (!arr.length) {
            // allow empty (treated as missing)
        } else {
            for (const rule of arr) {
                if (!isObject(rule)) {
                    throw invalid('INVALID_ORDER_BY', 'Invalid orderBy rule', { kind: 'validation', part: 'query', field: 'orderBy', opId: ctx.opId, resource: ctx.resource })
                }
                const field = (rule as any).field
                const direction = (rule as any).direction
                if (typeof field !== 'string' || !field || (direction !== 'asc' && direction !== 'desc')) {
                    throw invalid('INVALID_ORDER_BY', 'Invalid orderBy rule', { kind: 'validation', part: 'query', field: 'orderBy', opId: ctx.opId, resource: ctx.resource })
                }
            }
        }
    }

    const fields = (params as any).fields
    if (fields !== undefined) {
        if (!Array.isArray(fields) || fields.some(f => typeof f !== 'string' || !f)) {
            throw invalid('INVALID_QUERY', 'Invalid fields', { kind: 'validation', part: 'query', field: 'fields', opId: ctx.opId, resource: ctx.resource })
        }
    }

    const limit = (params as any).limit
    if (limit !== undefined) {
        const n = assertFiniteNumber(limit, { code: 'INVALID_QUERY', message: 'Invalid limit', details: { kind: 'validation', part: 'query', field: 'limit', opId: ctx.opId, resource: ctx.resource } })
        if (n < 0) throw invalid('INVALID_QUERY', 'Invalid limit', { kind: 'validation', part: 'query', field: 'limit', opId: ctx.opId, resource: ctx.resource })
    }
    const offset = (params as any).offset
    if (offset !== undefined) {
        const n = assertFiniteNumber(offset, { code: 'INVALID_QUERY', message: 'Invalid offset', details: { kind: 'validation', part: 'query', field: 'offset', opId: ctx.opId, resource: ctx.resource } })
        if (n < 0) throw invalid('INVALID_QUERY', 'Invalid offset', { kind: 'validation', part: 'query', field: 'offset', opId: ctx.opId, resource: ctx.resource })
    }
    const includeTotal = (params as any).includeTotal
    if (includeTotal !== undefined && typeof includeTotal !== 'boolean') {
        throw invalid('INVALID_QUERY', 'Invalid includeTotal', { kind: 'validation', part: 'query', field: 'includeTotal', opId: ctx.opId, resource: ctx.resource })
    }
    const after = (params as any).after
    if (after !== undefined && (typeof after !== 'string' || !after)) {
        throw invalid('INVALID_QUERY', 'Invalid after', { kind: 'validation', part: 'query', field: 'after', opId: ctx.opId, resource: ctx.resource })
    }
    const before = (params as any).before
    if (before !== undefined && (typeof before !== 'string' || !before)) {
        throw invalid('INVALID_QUERY', 'Invalid before', { kind: 'validation', part: 'query', field: 'before', opId: ctx.opId, resource: ctx.resource })
    }

    return params
}

