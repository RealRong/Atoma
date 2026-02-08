import type { Query } from 'atoma-types/core'

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectFilterFields(filter: unknown, output: Set<string>) {
    if (!isRecord(filter)) return

    const op = filter.op
    if (op === 'and' || op === 'or') {
        const args = filter.args
        if (Array.isArray(args)) args.forEach(arg => collectFilterFields(arg, output))
        return
    }

    if (op === 'not') {
        collectFilterFields(filter.arg, output)
        return
    }

    const field = filter.field
    if (typeof field === 'string' && field) output.add(field)
}

export function summarizeQuery<T>(query?: Query<T>) {
    if (!query) return {}

    const fieldSet = new Set<string>()
    collectFilterFields(query.filter, fieldSet)
    const filterFields = fieldSet.size ? Array.from(fieldSet) : undefined

    const sortFields = Array.isArray(query.sort)
        ? query.sort.map(rule => String(rule.field))
        : undefined

    const page = query.page

    const offset = page?.mode === 'offset' && typeof page.offset === 'number'
        ? page.offset
        : undefined

    const includeTotal = page?.mode === 'offset' && typeof page.includeTotal === 'boolean'
        ? page.includeTotal
        : undefined

    const after = page?.mode === 'cursor' && typeof page.after === 'string'
        ? page.after
        : undefined

    const before = page?.mode === 'cursor' && typeof page.before === 'string'
        ? page.before
        : undefined

    return {
        filterFields,
        sortFields,
        pageMode: page?.mode,
        limit: typeof page?.limit === 'number' ? page.limit : undefined,
        offset,
        after,
        before,
        includeTotal,
        select: Array.isArray(query.select) ? query.select : undefined
    }
}
