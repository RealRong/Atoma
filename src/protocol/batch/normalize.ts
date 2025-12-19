import type { BatchOp, BatchRequest } from './types'
import type { QueryParams, Page } from './query'

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function queryParams(params: QueryParams): QueryParams {
    const p: any = (params && typeof params === 'object') ? { ...(params as any) } : {}

    const where = p.where
    if (where !== undefined && !isPlainObject(where)) {
        delete p.where
    }

    const orderBy = p.orderBy
    if (orderBy !== undefined && !Array.isArray(orderBy)) {
        delete p.orderBy
    } else if (Array.isArray(orderBy)) {
        p.orderBy = orderBy
            .filter(r => isPlainObject(r) && typeof r.field === 'string' && r.field)
            .map(r => ({ field: r.field, direction: r.direction === 'asc' ? 'asc' : 'desc' }))
    }

    const fields = p.fields
    if (fields !== undefined && p.select === undefined) {
        const select: Record<string, boolean> = {}
        if (Array.isArray(fields)) {
            fields.forEach((f: any) => { if (typeof f === 'string' && f) select[f] = true })
        } else if (typeof fields === 'string') {
            fields.split(',').forEach(part => {
                const trimmed = part.trim()
                if (trimmed) select[trimmed] = true
            })
        }
        if (Object.keys(select).length) p.select = select
        delete p.fields
    }

    const select = p.select
    if (select !== undefined) {
        if (!isPlainObject(select)) {
            delete p.select
        } else {
            const out: Record<string, boolean> = {}
            for (const [k, v] of Object.entries(select)) {
                if (!k) continue
                if (typeof v === 'boolean') out[k] = v
            }
            p.select = Object.keys(out).length ? out : undefined
            if (!p.select) delete p.select
        }
    }

    const page = p.page
    if (page !== undefined) {
        const normalized = normalizePage(page)
        if (normalized) p.page = normalized
        else delete p.page
    }

    return p as QueryParams
}

function normalizePage(page: any): Page | undefined {
    if (!page || typeof page !== 'object') return undefined
    const mode = (page as any).mode
    if (mode === 'offset') {
        const limit = Number((page as any).limit)
        if (!Number.isFinite(limit) || limit <= 0) return undefined
        const offsetRaw = (page as any).offset
        const offset = offsetRaw === undefined ? undefined : Number(offsetRaw)
        if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) return undefined
        const includeTotal = (page as any).includeTotal
        if (includeTotal !== undefined && typeof includeTotal !== 'boolean') return undefined
        return {
            mode: 'offset',
            limit: Math.floor(limit),
            ...(offset !== undefined ? { offset: Math.floor(offset) } : {}),
            includeTotal: includeTotal ?? true
        }
    }
    if (mode === 'cursor') {
        const limit = Number((page as any).limit)
        if (!Number.isFinite(limit) || limit <= 0) return undefined
        const after = (page as any).after
        const before = (page as any).before
        if (after !== undefined && typeof after !== 'string') return undefined
        if (before !== undefined && typeof before !== 'string') return undefined
        if (after && before) return undefined
        return {
            mode: 'cursor',
            limit: Math.floor(limit),
            ...(typeof after === 'string' && after ? { after } : {}),
            ...(typeof before === 'string' && before ? { before } : {})
        }
    }
    return undefined
}

export function request(req: BatchRequest): BatchRequest {
    const traceId = typeof (req as any)?.traceId === 'string' && (req as any).traceId ? (req as any).traceId : undefined
    const requestId = typeof (req as any)?.requestId === 'string' && (req as any).requestId ? (req as any).requestId : undefined

    const ops = Array.isArray(req.ops) ? req.ops : []
    const normalizedOps: BatchOp[] = ops.map(op => {
        if (op.action === 'query') {
            return {
                ...op,
                query: {
                    ...op.query,
                    params: queryParams(op.query.params)
                }
            }
        }
        return op
    })

    return {
        ops: normalizedOps,
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }
}
