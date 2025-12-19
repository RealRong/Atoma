import type { BatchOp, BatchRequest } from './types'
import type { QueryParams, OrderByRule, Page } from './query'
import type { StandardError } from '../error/types'
import { create as createError } from '../error/fns'
import type { Result } from '../shared/result'
import { ok, err } from '../shared/result'

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOrderBy(orderBy: any, meta?: { traceId?: string; requestId?: string }): OrderByRule[] | undefined {
    if (!orderBy) return undefined

    const normalizeOne = (rule: any): OrderByRule => {
        if (typeof rule === 'string') {
            const [field, dir] = rule.split(':')
            if (!field) {
                throw protocolError('INVALID_ORDER_BY', 'Invalid orderBy', { kind: 'validation', path: 'orderBy', ...(meta || {}) })
            }
            const direction = dir?.toLowerCase() === 'asc' ? 'asc' : 'desc'
            return { field, direction }
        }

        if (!isPlainObject(rule)) {
            throw protocolError('INVALID_ORDER_BY', 'Invalid orderBy', { kind: 'validation', path: 'orderBy', ...(meta || {}) })
        }

        const field = rule.field
        const direction = rule.direction
        if (typeof field !== 'string' || !field) {
            throw protocolError('INVALID_ORDER_BY', 'Invalid orderBy.field', { kind: 'validation', path: 'orderBy.field', ...(meta || {}) })
        }
        if (direction !== 'asc' && direction !== 'desc') {
            return { field, direction: 'desc' }
        }
        return { field, direction }
    }

    if (Array.isArray(orderBy)) return orderBy.map(normalizeOne)
    return [normalizeOne(orderBy)]
}

function normalizeSelect(select: any, fields: any, meta?: { traceId?: string; requestId?: string }): Record<string, boolean> | undefined {
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
            throw protocolError('INVALID_QUERY', 'Invalid fields', { kind: 'validation', path: 'fields', ...(meta || {}) })
        }
    }

    if (select === undefined || select === null) {
        return base && Object.keys(base).length ? base : undefined
    }

    if (!isPlainObject(select)) {
        throw protocolError('INVALID_QUERY', 'Invalid select', { kind: 'validation', path: 'select', ...(meta || {}) })
    }

    const normalized: Record<string, boolean> = base ? { ...base } : {}
    for (const [field, enabled] of Object.entries(select)) {
        if (enabled === undefined) continue
        if (typeof enabled !== 'boolean') {
            throw protocolError('INVALID_QUERY', `Invalid select.${field}`, { kind: 'validation', path: `select.${field}`, ...(meta || {}) })
        }
        normalized[field] = enabled
    }

    return Object.keys(normalized).length ? normalized : undefined
}

function normalizeWhere(where: any, meta?: { traceId?: string; requestId?: string }): QueryParams['where'] | undefined {
    if (!where) return undefined
    if (!isPlainObject(where)) {
        throw protocolError('INVALID_QUERY', 'Invalid where', { kind: 'validation', path: 'where', ...(meta || {}) })
    }

    const out: Record<string, any> = {}
    for (const [field, cond] of Object.entries(where)) {
        if (cond === undefined) continue

        if (isPlainObject(cond)) {
            out[field] = normalizeWhereOps(field, cond as Record<string, any>, meta)
            continue
        }

        if (Array.isArray(cond)) {
            throw protocolError('INVALID_QUERY', `Invalid where.${field}`, { kind: 'validation', path: `where.${field}`, ...(meta || {}) })
        }

        out[field] = normalizeWherePrimitive(cond, `where.${field}`, meta)
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

function normalizeWhereOps(field: string, ops: Record<string, any>, meta?: { traceId?: string; requestId?: string }) {
    const out: Record<string, any> = {}

    for (const [op, value] of Object.entries(ops)) {
        if (!ALLOWED_WHERE_OPS.has(op)) {
            throw protocolError('INVALID_QUERY', `Invalid where operator: ${op}`, { kind: 'validation', path: `where.${field}.${op}`, ...(meta || {}) })
        }

        if (op === 'in') {
            if (!Array.isArray(value)) {
                throw protocolError('INVALID_QUERY', 'Invalid where.in (must be an array)', { kind: 'validation', path: `where.${field}.in`, ...(meta || {}) })
            }
            out.in = value.map((v, idx) => normalizeWherePrimitive(v, `where.${field}.in[${idx}]`, meta))
            continue
        }

        if (value === undefined) continue
        if (Array.isArray(value) || isPlainObject(value)) {
            throw protocolError('INVALID_QUERY', `Invalid where.${op}`, { kind: 'validation', path: `where.${field}.${op}`, ...(meta || {}) })
        }

        const normalized = normalizeWherePrimitive(value, `where.${field}.${op}`, meta)

        if ((op === 'startsWith' || op === 'endsWith' || op === 'contains') && typeof normalized !== 'string') {
            throw protocolError('INVALID_QUERY', `Invalid where.${op} (must be a string)`, { kind: 'validation', path: `where.${field}.${op}`, ...(meta || {}) })
        }

        out[op] = normalized
    }

    return out
}

function normalizeWherePrimitive(value: any, label: string, meta?: { traceId?: string; requestId?: string }) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        throw protocolError('INVALID_QUERY', `Invalid ${label}`, { kind: 'validation', path: label, ...(meta || {}) })
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value
    }
    throw protocolError('INVALID_QUERY', `Invalid ${label}`, { kind: 'validation', path: label, ...(meta || {}) })
}

function normalizePage(page: any, meta?: { traceId?: string; requestId?: string }): Page | undefined {
    if (!page) return undefined
    if (!page || typeof page !== 'object') {
        throw protocolError('INVALID_QUERY', 'Invalid page', { kind: 'validation', path: 'page', ...(meta || {}) })
    }

    if ((page as any).mode === 'offset') {
        const limit = Number((page as any).limit)
        if (!Number.isFinite(limit) || limit <= 0) {
            throw protocolError('INVALID_QUERY', 'Invalid page.limit', { kind: 'validation', path: 'page.limit', ...(meta || {}) })
        }
        const offsetRaw = (page as any).offset
        const offset = offsetRaw === undefined ? undefined : Number(offsetRaw)
        if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
            throw protocolError('INVALID_QUERY', 'Invalid page.offset', { kind: 'validation', path: 'page.offset', ...(meta || {}) })
        }
        const includeTotal = (page as any).includeTotal
        if (includeTotal !== undefined && typeof includeTotal !== 'boolean') {
            throw protocolError('INVALID_QUERY', 'Invalid page.includeTotal', { kind: 'validation', path: 'page.includeTotal', ...(meta || {}) })
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
            throw protocolError('INVALID_QUERY', 'Invalid page.limit', { kind: 'validation', path: 'page.limit', ...(meta || {}) })
        }
        const after = (page as any).after
        const before = (page as any).before
        if (after !== undefined && typeof after !== 'string') {
            throw protocolError('INVALID_QUERY', 'Invalid page.after', { kind: 'validation', path: 'page.after', ...(meta || {}) })
        }
        if (before !== undefined && typeof before !== 'string') {
            throw protocolError('INVALID_QUERY', 'Invalid page.before', { kind: 'validation', path: 'page.before', ...(meta || {}) })
        }
        if (after && before) {
            throw protocolError('INVALID_QUERY', 'page.after and page.before are mutually exclusive', { kind: 'validation', path: 'page', ...(meta || {}) })
        }
        return { mode: 'cursor', limit, after, before }
    }

    throw protocolError('INVALID_QUERY', 'Invalid page.mode', { kind: 'validation', path: 'page.mode', ...(meta || {}) })
}

function protocolError(code: string, message: string, details: any): StandardError {
    return createError(code, message, details)
}

export function validateBatchRequest(body: unknown): Result<BatchRequest> {
    try {
        const input: any = body
        const traceId = typeof input?.traceId === 'string' && input.traceId ? input.traceId : undefined
        const requestId = typeof input?.requestId === 'string' && input.requestId ? input.requestId : undefined
        const meta = {
            ...(traceId ? { traceId } : {}),
            ...(requestId ? { requestId } : {})
        }

        if (!input || !Array.isArray(input.ops)) {
            return err(protocolError('INVALID_REQUEST', 'Invalid Atoma request payload', { kind: 'validation', path: 'ops', ...meta }))
        }

        const seen = new Set<string>()
        const ops: BatchOp[] = input.ops.map((op: any, index: number) => {
            if (!op || typeof op !== 'object') {
                throw protocolError('INVALID_REQUEST', 'Invalid op', { kind: 'validation', path: `ops[${index}]`, ...meta })
            }

            const opId = op.opId
            if (typeof opId !== 'string' || !opId) {
                throw protocolError('INVALID_REQUEST', 'Invalid opId', { kind: 'validation', path: `ops[${index}].opId`, ...meta })
            }
            if (seen.has(opId)) {
                throw protocolError('INVALID_REQUEST', 'Duplicate opId', { kind: 'validation', path: `ops[${index}].opId`, ...meta })
            }
            seen.add(opId)

            const actionRaw = op.action
            if (typeof actionRaw !== 'string') {
                throw protocolError('INVALID_REQUEST', 'Invalid op action', { kind: 'validation', path: `ops[${index}].action`, ...meta })
            }

            const action = actionRaw as any

            if (action === 'query') {
                if (!op.query || typeof op.query !== 'object') {
                    throw protocolError('INVALID_QUERY', 'Invalid query op', { kind: 'validation', path: `ops[${index}].query`, ...meta })
                }
                if (typeof op.query.resource !== 'string' || !op.query.resource) {
                    throw protocolError('INVALID_QUERY', 'Invalid query: resource missing', { kind: 'validation', path: `ops[${index}].query.resource`, ...meta })
                }

                const params: QueryParams = isPlainObject(op.query.params) ? { ...op.query.params } : {}
                params.where = normalizeWhere(params.where, meta)
                params.orderBy = normalizeOrderBy((params as any).orderBy, meta)
                params.select = normalizeSelect((params as any).select, (params as any).fields, meta)
                delete (params as any).fields
                params.page = normalizePage((params as any).page, meta)
                if (!params.page) {
                    throw protocolError('INVALID_QUERY', 'Missing params.page', { kind: 'validation', path: `ops[${index}].query.params.page`, ...meta })
                }

                return {
                    opId,
                    action: 'query',
                    query: { resource: op.query.resource, params }
                } as BatchOp
            }

            const resource = op.resource
            if (typeof resource !== 'string' || !resource) {
                throw protocolError('INVALID_WRITE', 'Invalid write payload: resource missing', { kind: 'validation', path: `ops[${index}].resource`, ...meta })
            }

            const options = isPlainObject(op.options) ? op.options : undefined

            const payload = op.payload
            if (!Array.isArray(payload)) {
                throw protocolError('INVALID_PAYLOAD', `Payload for ${action} must be an array`, { kind: 'validation', path: `ops[${index}].payload`, ...meta })
            }

            if (action === 'bulkCreate') {
                payload.forEach((item: any, i2: number) => {
                    if (!isPlainObject(item) || item.data === undefined) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkCreate item (expected { data, meta? })', { kind: 'validation', path: `ops[${index}].payload[${i2}]`, ...meta })
                    }
                    if (item.meta !== undefined && !isPlainObject(item.meta)) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkCreate item.meta', { kind: 'validation', path: `ops[${index}].payload[${i2}].meta`, ...meta })
                    }
                })
                return { opId, action, resource, payload, options } as BatchOp
            }

            if (action === 'bulkUpdate') {
                payload.forEach((item: any, i2: number) => {
                    if (!isPlainObject(item) || item.id === undefined || item.data === undefined) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkUpdate item (expected { id, data, baseVersion, meta? })', { kind: 'validation', path: `ops[${index}].payload[${i2}]`, ...meta })
                    }
                    const baseVersion = item.baseVersion
                    if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion >= 0)) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkUpdate item.baseVersion', { kind: 'validation', path: `ops[${index}].payload[${i2}].baseVersion`, ...meta })
                    }
                    if (item.meta !== undefined && !isPlainObject(item.meta)) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkUpdate item.meta', { kind: 'validation', path: `ops[${index}].payload[${i2}].meta`, ...meta })
                    }
                })
                return { opId, action, resource, payload, options } as BatchOp
            }

            if (action === 'bulkPatch') {
                payload.forEach((item: any, i2: number) => {
                    if (!isPlainObject(item) || item.id === undefined || !Array.isArray(item.patches)) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkPatch item (expected { id, patches, baseVersion, meta? })', { kind: 'validation', path: `ops[${index}].payload[${i2}]`, ...meta })
                    }
                    const baseVersion = item.baseVersion
                    if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion >= 0)) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkPatch item.baseVersion', { kind: 'validation', path: `ops[${index}].payload[${i2}].baseVersion`, ...meta })
                    }
                    if (item.meta !== undefined && !isPlainObject(item.meta)) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkPatch item.meta', { kind: 'validation', path: `ops[${index}].payload[${i2}].meta`, ...meta })
                    }
                })
                return { opId, action, resource, payload, options } as BatchOp
            }

            if (action === 'bulkDelete') {
                payload.forEach((item: any, i2: number) => {
                    if (!isPlainObject(item) || item.id === undefined) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkDelete item (expected { id, baseVersion, meta? })', { kind: 'validation', path: `ops[${index}].payload[${i2}]`, ...meta })
                    }
                    const baseVersion = item.baseVersion
                    if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion >= 0)) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkDelete item.baseVersion', { kind: 'validation', path: `ops[${index}].payload[${i2}].baseVersion`, ...meta })
                    }
                    if (item.meta !== undefined && !isPlainObject(item.meta)) {
                        throw protocolError('INVALID_PAYLOAD', 'Invalid bulkDelete item.meta', { kind: 'validation', path: `ops[${index}].payload[${i2}].meta`, ...meta })
                    }
                })
                return { opId, action, resource, payload, options } as BatchOp
            }

            throw protocolError('UNSUPPORTED_ACTION', `Unsupported action: ${actionRaw}`, { kind: 'validation', path: `ops[${index}].action`, ...meta })
        })

        return ok({ ops, ...meta })
    } catch (e: any) {
        if (e && typeof e === 'object' && typeof (e as any).code === 'string' && typeof (e as any).message === 'string') {
            return err(e as StandardError)
        }
        return err(createError('INTERNAL', 'Internal error', { kind: 'internal' }))
    }
}

export function validateBatchOp(input: unknown): Result<BatchOp> {
    const res = validateBatchRequest({ ops: [input] })
    if (!res.ok) return res
    const first = Array.isArray(res.value.ops) ? res.value.ops[0] : undefined
    if (!first) return err(createError('INVALID_REQUEST', 'Invalid op', { kind: 'validation', path: 'op' }), 422)
    return ok(first)
}
