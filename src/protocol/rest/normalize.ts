import type { Page, QueryParams } from '../batch/query'

export function queryParamsFromSearchParams(searchParams: URLSearchParams): QueryParams {
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

    if (after || before) {
        const page: Extract<Page, { mode: 'cursor' }> = { mode: 'cursor', limit: typeof limit === 'number' ? limit : 50 }
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

export function toNumberIfFinite(v: any) {
    const n = Number(v)
    return Number.isFinite(n) ? n : v
}
