import type { QueryParams } from '../query'
import { assertFiniteNumber, invalid, isObject, isPlainObject, makeValidationDetails, requireObject } from './common'

export function assertQueryParams(value: unknown, ctx: { opId: string; resource: string }): QueryParams {
    const detailsFor = makeValidationDetails('query', { opId: ctx.opId, resource: ctx.resource })

    const paramsObj = requireObject(value, { code: 'INVALID_REQUEST', message: 'Missing query.params', details: detailsFor() })
    const params = paramsObj as unknown as QueryParams

    const validators: Array<() => void> = []

    validators.push(() => {
        const where = (params as any).where
        if (where !== undefined && !isPlainObject(where)) {
            throw invalid('INVALID_QUERY', 'Invalid where (must be a plain object)', detailsFor('where'))
        }
    })

    validators.push(() => {
        const orderBy = (params as any).orderBy
        if (orderBy === undefined) return

        const arr = Array.isArray(orderBy) ? orderBy : [orderBy]
        if (!arr.length) return // allow empty (treated as missing)

        for (const rule of arr) {
            if (!isObject(rule)) {
                throw invalid('INVALID_ORDER_BY', 'Invalid orderBy rule', detailsFor('orderBy'))
            }
            const field = (rule as any).field
            const direction = (rule as any).direction
            if (typeof field !== 'string' || !field || (direction !== 'asc' && direction !== 'desc')) {
                throw invalid('INVALID_ORDER_BY', 'Invalid orderBy rule', detailsFor('orderBy'))
            }
        }
    })

    validators.push(() => {
        const fields = (params as any).fields
        if (fields === undefined) return
        if (!Array.isArray(fields) || fields.some(f => typeof f !== 'string' || !f)) {
            throw invalid('INVALID_QUERY', 'Invalid fields', detailsFor('fields'))
        }
    })

    const validateOptionalNonNegativeNumber = (field: 'limit' | 'offset', code: string, message: string) => {
        const raw = (params as any)[field]
        if (raw === undefined) return
        const n = assertFiniteNumber(raw, { code, message, details: detailsFor(field) })
        if (n < 0) throw invalid(code, message, detailsFor(field))
    }

    validators.push(() => validateOptionalNonNegativeNumber('limit', 'INVALID_QUERY', 'Invalid limit'))
    validators.push(() => validateOptionalNonNegativeNumber('offset', 'INVALID_QUERY', 'Invalid offset'))

    validators.push(() => {
        const includeTotal = (params as any).includeTotal
        if (includeTotal !== undefined && typeof includeTotal !== 'boolean') {
            throw invalid('INVALID_QUERY', 'Invalid includeTotal', detailsFor('includeTotal'))
        }
    })

    const validateOptionalCursorToken = (field: 'after' | 'before', message: string) => {
        const v = (params as any)[field]
        if (v === undefined) return
        if (typeof v !== 'string' || !v) throw invalid('INVALID_QUERY', message, detailsFor(field))
    }

    validators.push(() => validateOptionalCursorToken('after', 'Invalid after'))
    validators.push(() => validateOptionalCursorToken('before', 'Invalid before'))

    validators.forEach(v => v())

    return params
}
