import type { FilterExpr, PageSpec, Query, SortRule } from 'atoma-types/protocol'
import { assertFiniteNumber, invalid, isObject, isPlainObject, makeValidationDetails, requireArray, requireObject, requireString } from './common'

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
}

function assertSortRule(value: unknown, detailsFor: ReturnType<typeof makeValidationDetails>): SortRule {
    if (!isObject(value)) {
        throw invalid('INVALID_SORT', 'Invalid sort rule', detailsFor('sort'))
    }
    const field = (value as any).field
    const dir = (value as any).dir
    if (!isNonEmptyString(field) || (dir !== 'asc' && dir !== 'desc')) {
        throw invalid('INVALID_SORT', 'Invalid sort rule', detailsFor('sort'))
    }
    return { field, dir }
}

function assertCursorToken(value: unknown, detailsFor: ReturnType<typeof makeValidationDetails>, field: string) {
    if (!isNonEmptyString(value)) {
        throw invalid('INVALID_CURSOR', 'Invalid cursor', detailsFor(field))
    }
    const decoded = decodeCursorToken(value)
    if (!decoded) {
        throw invalid('INVALID_CURSOR', 'Invalid cursor', detailsFor(field))
    }
    if (decoded.v !== 1 || !Array.isArray(decoded.sort) || !Array.isArray(decoded.values)) {
        throw invalid('INVALID_CURSOR', 'Invalid cursor', detailsFor(field))
    }
    if (decoded.sort.length && decoded.values.length < decoded.sort.length) {
        throw invalid('INVALID_CURSOR', 'Invalid cursor', detailsFor(field))
    }
    decoded.sort.forEach((r: any) => { void assertSortRule(r, detailsFor) })
}

function decodeCursorToken(token: string): { v: number; sort: SortRule[]; values: unknown[] } | null {
    try {
        const json = base64UrlDecode(token)
        const parsed = JSON.parse(json) as any
        if (!parsed || typeof parsed !== 'object') return null
        return parsed
    } catch {
        return null
    }
}

function base64UrlDecode(input: string): string {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/')
    const padLen = (4 - (padded.length % 4)) % 4
    const base64 = padded + '='.repeat(padLen)
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(base64, 'base64').toString('utf8')
    }
    return decodeURIComponent(escape(atob(base64)))
}

function assertPageSpec(value: unknown, detailsFor: ReturnType<typeof makeValidationDetails>): PageSpec {
    const obj = requireObject(value, { code: 'INVALID_PAGE', message: 'Invalid page', details: detailsFor('page') })
    const mode = (obj as any).mode
    if (mode !== 'offset' && mode !== 'cursor') {
        throw invalid('INVALID_PAGE', 'Invalid page.mode', detailsFor('page.mode'))
    }

    if (mode === 'offset') {
        const limit = (obj as any).limit
        const offset = (obj as any).offset
        const includeTotal = (obj as any).includeTotal
        if (limit !== undefined) {
            const n = assertFiniteNumber(limit, { code: 'INVALID_PAGE', message: 'Invalid page.limit', details: detailsFor('page.limit') })
            if (n < 0) throw invalid('INVALID_PAGE', 'Invalid page.limit', detailsFor('page.limit'))
        }
        if (offset !== undefined) {
            const n = assertFiniteNumber(offset, { code: 'INVALID_PAGE', message: 'Invalid page.offset', details: detailsFor('page.offset') })
            if (n < 0) throw invalid('INVALID_PAGE', 'Invalid page.offset', detailsFor('page.offset'))
        }
        if (includeTotal !== undefined && typeof includeTotal !== 'boolean') {
            throw invalid('INVALID_PAGE', 'Invalid page.includeTotal', detailsFor('page.includeTotal'))
        }
        return obj as PageSpec
    }

    const limit = (obj as any).limit
    const after = (obj as any).after
    const before = (obj as any).before
    if (limit !== undefined) {
        const n = assertFiniteNumber(limit, { code: 'INVALID_PAGE', message: 'Invalid page.limit', details: detailsFor('page.limit') })
        if (n < 0) throw invalid('INVALID_PAGE', 'Invalid page.limit', detailsFor('page.limit'))
    }
    if (after !== undefined) assertCursorToken(after, detailsFor, 'page.after')
    if (before !== undefined) assertCursorToken(before, detailsFor, 'page.before')
    if (after !== undefined && before !== undefined) {
        throw invalid('INVALID_PAGE', 'Invalid page (both after and before)', detailsFor('page'))
    }
    return obj as PageSpec
}

export function assertFilterExpr(value: unknown, ctx: { opId: string; resource: string }): FilterExpr {
    const detailsFor = makeValidationDetails('filter', { opId: ctx.opId, resource: ctx.resource })
    if (!isObject(value)) {
        throw invalid('INVALID_FILTER', 'Invalid filter', detailsFor())
    }
    const op = (value as any).op

    switch (op) {
        case 'and':
        case 'or': {
            const args = requireArray((value as any).args, { code: 'INVALID_FILTER', message: 'Invalid filter.args', details: detailsFor('args') })
            args.forEach(a => { void assertFilterExpr(a, ctx) })
            return value as FilterExpr
        }
        case 'not': {
            const arg = (value as any).arg
            if (!isObject(arg)) throw invalid('INVALID_FILTER', 'Invalid filter.arg', detailsFor('arg'))
            void assertFilterExpr(arg, ctx)
            return value as FilterExpr
        }
        case 'eq':
        case 'in':
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte':
        case 'startsWith':
        case 'endsWith':
        case 'contains':
        case 'isNull':
        case 'exists':
        case 'text':
            break
        default:
            throw invalid('INVALID_FILTER', 'Invalid filter.op', detailsFor('op'))
    }

    const field = (value as any).field
    if (!isNonEmptyString(field)) {
        throw invalid('INVALID_FILTER', 'Invalid filter.field', detailsFor('field'))
    }

    switch (op) {
        case 'eq':
            return value as FilterExpr
        case 'in': {
            const values = (value as any).values
            if (!Array.isArray(values)) throw invalid('INVALID_FILTER', 'Invalid filter.values', detailsFor('values'))
            return value as FilterExpr
        }
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
            const v = (value as any).value
            const n = assertFiniteNumber(v, { code: 'INVALID_FILTER', message: 'Invalid filter.value', details: detailsFor('value') })
            if (!Number.isFinite(n)) throw invalid('INVALID_FILTER', 'Invalid filter.value', detailsFor('value'))
            return value as FilterExpr
        }
        case 'startsWith':
        case 'endsWith':
        case 'contains': {
            const v = (value as any).value
            if (!isNonEmptyString(v)) throw invalid('INVALID_FILTER', 'Invalid filter.value', detailsFor('value'))
            return value as FilterExpr
        }
        case 'isNull':
        case 'exists':
            return value as FilterExpr
        case 'text': {
            const query = (value as any).query
            if (!isNonEmptyString(query)) throw invalid('INVALID_FILTER', 'Invalid filter.query', detailsFor('query'))
            const mode = (value as any).mode
            if (mode !== undefined && mode !== 'match' && mode !== 'fuzzy') {
                throw invalid('INVALID_FILTER', 'Invalid filter.mode', detailsFor('mode'))
            }
            const distance = (value as any).distance
            if (distance !== undefined && distance !== 0 && distance !== 1 && distance !== 2) {
                throw invalid('INVALID_FILTER', 'Invalid filter.distance', detailsFor('distance'))
            }
            return value as FilterExpr
        }
    }

    throw invalid('INVALID_FILTER', 'Invalid filter', detailsFor())
}

export function assertQuery(value: unknown, ctx: { opId: string; resource: string }): Query {
    const detailsFor = makeValidationDetails('query', { opId: ctx.opId, resource: ctx.resource })
    const obj = requireObject(value, { code: 'INVALID_QUERY', message: 'Invalid query', details: detailsFor() })

    const filter = (obj as any).filter
    if (filter !== undefined) {
        void assertFilterExpr(filter, ctx)
    }

    const sort = (obj as any).sort
    if (sort !== undefined) {
        const arr = requireArray(sort, { code: 'INVALID_SORT', message: 'Invalid sort', details: detailsFor('sort') })
        arr.forEach(rule => { void assertSortRule(rule, detailsFor) })
    }

    const page = (obj as any).page
    if (page !== undefined) {
        void assertPageSpec(page, detailsFor)
    }

    const select = (obj as any).select
    if (select !== undefined) {
        const arr = requireArray(select, { code: 'INVALID_SELECT', message: 'Invalid select', details: detailsFor('select') })
        if (arr.some(v => !isNonEmptyString(v))) {
            throw invalid('INVALID_SELECT', 'Invalid select', detailsFor('select'))
        }
    }

    const include = (obj as any).include
    if (include !== undefined) {
        if (!isPlainObject(include)) throw invalid('INVALID_INCLUDE', 'Invalid include', detailsFor('include'))
        Object.entries(include).forEach(([k, v]) => {
            if (!isNonEmptyString(k)) throw invalid('INVALID_INCLUDE', 'Invalid include key', detailsFor('include'))
            void assertQuery(v, ctx)
        })
    }

    return obj as Query
}
