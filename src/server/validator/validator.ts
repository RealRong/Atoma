import lodash from 'lodash'
import type { Action, BatchOp, BatchRequest, OrderByRule, Page, QueryParams, WriteOptions } from '../types'
import { throwError } from '../error'

export function validateAndNormalizeRequest(body: any): BatchRequest {
    if (!body || !Array.isArray(body.ops)) {
        throwError('INVALID_REQUEST', 'Invalid Atoma request payload', { kind: 'validation', path: 'ops' })
    }

    const seen = new Set<string>()
    const ops: BatchOp[] = body.ops.map((op: any, index: number) => {
        if (!op || typeof op !== 'object') {
            throwError('INVALID_REQUEST', 'Invalid op', { kind: 'validation', path: `ops[${index}]` })
        }

        const opId = op.opId
        if (typeof opId !== 'string' || !opId) {
            throwError('INVALID_REQUEST', 'Invalid opId', { kind: 'validation', path: `ops[${index}].opId` })
        }
        if (seen.has(opId)) {
            throwError('INVALID_REQUEST', 'Duplicate opId', { kind: 'validation', path: `ops[${index}].opId` })
        }
        seen.add(opId)

        const actionRaw = op.action
        if (typeof actionRaw !== 'string') {
            throwError('INVALID_REQUEST', 'Invalid op action', { kind: 'validation', path: `ops[${index}].action` })
        }
        const action = actionRaw as Action

        if (action === 'query') {
            if (!op.query || typeof op.query !== 'object') {
                throwError('INVALID_QUERY', 'Invalid query op', { kind: 'validation', path: `ops[${index}].query` })
            }
            if (typeof op.query.resource !== 'string' || !op.query.resource) {
                throwError('INVALID_QUERY', 'Invalid query: resource missing', {
                    kind: 'validation',
                    path: `ops[${index}].query.resource`
                })
            }
            const params: QueryParams = lodash.isPlainObject(op.query.params) ? { ...op.query.params } : {}
            params.where = normalizeWhere(params.where)
            params.orderBy = normalizeOrderBy((params as any).orderBy)
            params.select = normalizeSelect((params as any).select, (params as any).fields)
            delete (params as any).fields
            params.page = normalizePage((params as any).page)
            if (!params.page) {
                throwError('INVALID_QUERY', 'Missing params.page', {
                    kind: 'validation',
                    path: `ops[${index}].query.params.page`
                })
            }
            return {
                opId,
                action: 'query',
                query: { resource: op.query.resource, params }
            }
        }

        const resource = op.resource
        if (typeof resource !== 'string' || !resource) {
            throwError('INVALID_WRITE', 'Invalid write payload: resource missing', {
                kind: 'validation',
                path: `ops[${index}].resource`
            })
        }

        const options: WriteOptions | undefined = lodash.isPlainObject(op.options) ? op.options : undefined
        const payload = op.payload
        if (!Array.isArray(payload)) {
            throwError('INVALID_PAYLOAD', `Payload for ${action} must be an array`, {
                kind: 'validation',
                path: `ops[${index}].payload`
            })
        }

        if (action === 'bulkCreate') {
            return { opId, action, resource, payload, options }
        }
        if (action === 'bulkUpdate') {
            return { opId, action, resource, payload, options } as BatchOp
        }
        if (action === 'bulkPatch') {
            return { opId, action, resource, payload, options } as BatchOp
        }
        if (action === 'bulkDelete') {
            return { opId, action, resource, payload, options }
        }

        throwError('UNSUPPORTED_ACTION', `Unsupported action: ${actionRaw}`, {
            kind: 'validation',
            path: `ops[${index}].action`
        })
    })

    return { ops }
}

function normalizeOrderBy(orderBy: QueryParams['orderBy']): QueryParams['orderBy'] {
    if (!orderBy) return undefined

    const normalizeOne = (rule: any): OrderByRule => {
        if (typeof rule === 'string') {
            const [field, dir] = rule.split(':')
            if (!field) throwError('INVALID_ORDER_BY', 'Invalid orderBy', { kind: 'validation', path: 'orderBy' })
            const direction: OrderByRule['direction'] = dir?.toLowerCase() === 'asc' ? 'asc' : 'desc'
            return { field, direction }
        }
        if (rule && typeof rule === 'object' && typeof (rule as any).field === 'string') {
            const direction: OrderByRule['direction'] = (rule as any).direction === 'asc' ? 'asc' : 'desc'
            return { field: (rule as any).field, direction }
        }
        throwError('INVALID_ORDER_BY', 'Invalid orderBy', { kind: 'validation', path: 'orderBy' })
    }

    if (Array.isArray(orderBy)) return orderBy.map(normalizeOne)
    return [normalizeOne(orderBy)]
}

function normalizeSelect(select: QueryParams['select'] | undefined, fields: any): QueryParams['select'] | undefined {
    let base: Record<string, boolean> | undefined

    if (fields !== undefined) {
        const out: Record<string, boolean> = {}
        if (Array.isArray(fields)) {
            fields.forEach(f => {
                if (typeof f === 'string' && f) out[f] = true
            })
            base = out
        } else if (typeof fields === 'string') {
            fields.split(',').forEach(part => {
                const trimmed = part.trim()
                if (trimmed) out[trimmed] = true
            })
            base = out
        } else {
            throwError('INVALID_QUERY', 'Invalid fields', { kind: 'validation', path: 'fields' })
        }
    }

    if (select === undefined || select === null) {
        return base && Object.keys(base).length ? base : undefined
    }

    if (!lodash.isPlainObject(select)) {
        throwError('INVALID_QUERY', 'Invalid select', { kind: 'validation', path: 'select' })
    }

    const normalized: Record<string, boolean> = base ? { ...base } : {}
    for (const [field, enabled] of Object.entries(select)) {
        if (enabled === undefined) continue
        if (typeof enabled !== 'boolean') {
            throwError('INVALID_QUERY', `Invalid select.${field}`, { kind: 'validation', path: `select.${field}` })
        }
        normalized[field] = enabled
    }

    return Object.keys(normalized).length ? normalized : undefined
}

function normalizeWhere(where: QueryParams['where']): QueryParams['where'] | undefined {
    if (!where) return undefined
    if (!lodash.isPlainObject(where)) {
        throwError('INVALID_QUERY', 'Invalid where', { kind: 'validation', path: 'where' })
    }

    const out: Record<string, any> = {}
    for (const [field, cond] of Object.entries(where)) {
        if (cond === undefined) continue

        if (lodash.isPlainObject(cond)) {
            out[field] = normalizeWhereOps(field, cond as Record<string, any>)
            continue
        }

        if (Array.isArray(cond)) {
            throwError('INVALID_QUERY', `Invalid where.${field}`, { kind: 'validation', path: `where.${field}` })
        }

        out[field] = normalizeWherePrimitive(cond, `where.${field}`)
    }

    return Object.keys(out).length ? out : undefined
}

const ALLOWED_WHERE_OPS = new Set([
    'in',
    'gt',
    'gte',
    'lt',
    'lte',
    'startsWith',
    'endsWith',
    'contains'
])

function normalizeWhereOps(field: string, ops: Record<string, any>) {
    const out: Record<string, any> = {}

    for (const [op, value] of Object.entries(ops)) {
        if (!ALLOWED_WHERE_OPS.has(op)) {
            throwError('INVALID_QUERY', `Invalid where operator: ${op}`, { kind: 'validation', path: `where.${field}.${op}` })
        }

        if (op === 'in') {
            if (!Array.isArray(value)) {
                throwError('INVALID_QUERY', 'Invalid where.in (must be an array)', { kind: 'validation', path: `where.${field}.in` })
            }
            out.in = value.map((v, idx) => normalizeWherePrimitive(v, `where.${field}.in[${idx}]`))
            continue
        }

        if (value === undefined) continue
        if (Array.isArray(value) || lodash.isPlainObject(value)) {
            throwError('INVALID_QUERY', `Invalid where.${op}`, { kind: 'validation', path: `where.${field}.${op}` })
        }

        const normalized = normalizeWherePrimitive(value, `where.${field}.${op}`)

        // string-only ops
        if ((op === 'startsWith' || op === 'endsWith' || op === 'contains') && typeof normalized !== 'string') {
            throwError('INVALID_QUERY', `Invalid where.${op} (must be a string)`, { kind: 'validation', path: `where.${field}.${op}` })
        }

        out[op] = normalized
    }

    return out
}

function normalizeWherePrimitive(value: any, label: string) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        throwError('INVALID_QUERY', `Invalid ${label}`, { kind: 'validation', path: label })
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value
    }
    throwError('INVALID_QUERY', `Invalid ${label}`, { kind: 'validation', path: label })
}

function normalizePage(page: QueryParams['page']): Page | undefined {
    if (!page) return undefined
    if (!page || typeof page !== 'object') {
        throwError('INVALID_QUERY', 'Invalid page', { kind: 'validation', path: 'page' })
    }

    if ((page as any).mode === 'offset') {
        const limit = Number((page as any).limit)
        if (!Number.isFinite(limit) || limit <= 0) {
            throwError('INVALID_QUERY', 'Invalid page.limit', { kind: 'validation', path: 'page.limit' })
        }
        const offsetRaw = (page as any).offset
        const offset = offsetRaw === undefined ? undefined : Number(offsetRaw)
        if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
            throwError('INVALID_QUERY', 'Invalid page.offset', { kind: 'validation', path: 'page.offset' })
        }
        const includeTotal = (page as any).includeTotal
        if (includeTotal !== undefined && typeof includeTotal !== 'boolean') {
            throwError('INVALID_QUERY', 'Invalid page.includeTotal', { kind: 'validation', path: 'page.includeTotal' })
        }
        return {
            mode: 'offset',
            limit,
            offset,
            includeTotal: includeTotal ?? true
        }
    }

    if ((page as any).mode === 'cursor') {
        const limit = Number((page as any).limit)
        if (!Number.isFinite(limit) || limit <= 0) {
            throwError('INVALID_QUERY', 'Invalid page.limit', { kind: 'validation', path: 'page.limit' })
        }
        const after = (page as any).after
        const before = (page as any).before
        if (after !== undefined && typeof after !== 'string') {
            throwError('INVALID_QUERY', 'Invalid page.after', { kind: 'validation', path: 'page.after' })
        }
        if (before !== undefined && typeof before !== 'string') {
            throwError('INVALID_QUERY', 'Invalid page.before', { kind: 'validation', path: 'page.before' })
        }
        if (after && before) {
            throwError('INVALID_QUERY', 'page.after and page.before are mutually exclusive', { kind: 'validation', path: 'page' })
        }
        return { mode: 'cursor', limit, after, before }
    }

    throwError('INVALID_QUERY', 'Invalid page.mode', { kind: 'validation', path: 'page.mode' })
}
