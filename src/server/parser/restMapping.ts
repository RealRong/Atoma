import type { BatchOp, BatchRequest, Page, QueryParams } from '../types'

type RestMappingParams = {
    method: string
    pathParts: string[]
    searchParams: URLSearchParams
    body: any
}

export function restMapping({ method, pathParts, searchParams, body }: RestMappingParams): BatchRequest | null {
    const resource = pathParts[0]
    const id = pathParts[1]
    if (!resource) return null

    const params = parseQueryParams(searchParams)
    const numericId = toNumberIfFinite(id)
    const opId = 'rest:0'

    if (method === 'GET') {
        if (id !== undefined) {
            params.where = { ...(params.where || {}), id: numericId }
            params.page = { mode: 'offset', limit: 1, includeTotal: false }
        }
        const op: BatchOp = { opId, action: 'query', query: { resource, params } }
        return { ops: [op] }
    }

    if (method === 'POST' && id === undefined) {
        const op: BatchOp = {
            opId,
            action: 'bulkCreate',
            resource,
            payload: [body]
        }
        return { ops: [op] }
    }

    if ((method === 'PUT' || method === 'PATCH' || method === 'POST') && id !== undefined) {
        const isPatch = body && typeof body === 'object' && Array.isArray((body as any).patches)
        if (isPatch) {
            const op: BatchOp = {
                opId,
                action: 'bulkPatch',
                resource,
                payload: [{
                    id: numericId,
                    patches: (body as any).patches,
                    baseVersion: (body as any).baseVersion,
                    timestamp: (body as any).timestamp,
                    idempotencyKey: (body as any).idempotencyKey
                }]
            }
            return { ops: [op] }
        }

        const full = (body && typeof body === 'object') ? { ...stripWriteMeta(body), id: numericId } : { id: numericId }
        const op: BatchOp = {
            opId,
            action: 'bulkPatch',
            resource,
            payload: [{
                id: numericId,
                patches: [{ op: 'replace', path: [numericId], value: full }],
                baseVersion: (body as any)?.baseVersion,
                timestamp: (body as any)?.timestamp,
                idempotencyKey: (body as any)?.idempotencyKey
            }]
        }
        return { ops: [op] }
    }

    if (method === 'DELETE' && id !== undefined) {
        const op: BatchOp = {
            opId,
            action: 'bulkDelete',
            resource,
            payload: [{
                id: numericId,
                baseVersion: (body as any)?.baseVersion,
                idempotencyKey: (body as any)?.idempotencyKey
            }]
        }
        return { ops: [op] }
    }

    return null
}

function stripWriteMeta(body: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body
    const { baseVersion, timestamp, idempotencyKey, patches, ...rest } = body as any
    return rest
}

function parseQueryParams(searchParams: URLSearchParams): QueryParams {
    const params: QueryParams = {}
    const where: Record<string, any> = {}
    const orderRules: Array<{ field: string; direction: 'asc' | 'desc' }> = []
    const fields = new Set<string>()
    let limit: number | undefined
    let offset: number | undefined
    let after: string | undefined
    let before: string | undefined
    let includeTotal: boolean | undefined

    searchParams.forEach((value, key) => {
        if (key === 'fields') {
            value.split(',').forEach(part => {
                const trimmed = part.trim()
                if (trimmed) fields.add(trimmed)
            })
            return
        }
        if (key === 'limit') {
            limit = toNumberIfFinite(value) as number | undefined
            return
        }
        if (key === 'offset') {
            offset = toNumberIfFinite(value) as number | undefined
            return
        }
        if (key === 'after') {
            after = value
            return
        }
        if (key === 'before') {
            before = value
            return
        }
        if (key === 'includeTotal') {
            includeTotal = value === 'true'
            return
        }
        if (key === 'orderBy') {
            const [field, dir] = value.split(':')
            if (field) {
                orderRules.push({ field, direction: dir?.toLowerCase() === 'asc' ? 'asc' : 'desc' })
            }
            return
        }

        // where[field]=x
        // where[field][op]=x
        // where[field][in][]=1&where[field][in][]=2
        const mArr = key.match(/^where\[(.+?)\]\[(.+?)\]\[\]$/)
        if (mArr) {
            const field = mArr[1]
            const op = mArr[2]
            if (!field || !op) return

            const obj = ensureWhereObject(where, field)
            const list = Array.isArray(obj[op]) ? obj[op] : []
            list.push(toPrimitive(value))
            obj[op] = list
            return
        }

        const mOp = key.match(/^where\[(.+?)\]\[(.+?)\]$/)
        if (mOp) {
            const field = mOp[1]
            const op = mOp[2]
            if (!field || !op) return

            const obj = ensureWhereObject(where, field)
            if (op === 'in') {
                const list = Array.isArray(obj.in) ? obj.in : []
                list.push(toPrimitive(value))
                obj.in = list
                return
            }

            obj[op] = toPrimitive(value)
            return
        }

        const mEq = key.match(/^where\[(.+?)\]$/)
        if (mEq) {
            const field = mEq[1]
            if (!field) return
            where[field] = toPrimitive(value)
            return
        }
    })

    if (orderRules.length) params.orderBy = orderRules
    if (Object.keys(where).length) params.where = where
    if (fields.size) {
        const select: Record<string, boolean> = {}
        Array.from(fields).forEach(f => { select[f] = true })
        params.select = select
    }

    // 默认：不需要显式 pageMode。只要传 after/before 就走 cursor 分页；否则走 offset 分页。
    if (after || before) {
        const page: Page = { mode: 'cursor', limit: typeof limit === 'number' ? limit : 50 }
        if (after) page.after = after
        if (before) page.before = before
        params.page = page
    } else {
        params.page = {
            mode: 'offset',
            limit: typeof limit === 'number' ? limit : 50,
            offset,
            includeTotal: includeTotal ?? true
        }
    }
    return params
}

function ensureWhereObject(where: Record<string, any>, field: string) {
    const cur = where[field]
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
        // 若之前是 primitive（where[field]=x），这里直接覆盖成对象（以 op 形式为准）
        where[field] = {}
    }
    return where[field] as Record<string, any>
}

function toPrimitive(value: string) {
    if (value === 'true') return true
    if (value === 'false') return false
    const num = Number(value)
    if (Number.isFinite(num) && value.trim() !== '') return num
    return value
}

function toNumberIfFinite(v: any) {
    const n = Number(v)
    return Number.isFinite(n) ? n : v
}
