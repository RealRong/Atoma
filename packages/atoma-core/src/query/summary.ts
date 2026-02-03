import type { Query } from 'atoma-types/core'

function collectFilterFields(filter: any, out: Set<string>) {
    if (!filter || typeof filter !== 'object') return
    const op = (filter as any).op
    if (op === 'and' || op === 'or') {
        const args = (filter as any).args
        if (Array.isArray(args)) args.forEach(a => collectFilterFields(a, out))
        return
    }
    if (op === 'not') {
        collectFilterFields((filter as any).arg, out)
        return
    }
    const field = (filter as any).field
    if (typeof field === 'string' && field) out.add(field)
}

export function summarizeQuery<T>(query?: Query<T>) {
    if (!query) return {}

    const fieldSet = new Set<string>()
    collectFilterFields((query as any).filter, fieldSet)
    const filterFields = fieldSet.size ? Array.from(fieldSet) : undefined

    const sortFields = Array.isArray((query as any).sort)
        ? (query as any).sort.map((r: any) => String(r.field))
        : undefined

    const page = (query as any).page

    return {
        filterFields,
        sortFields,
        pageMode: page?.mode,
        limit: typeof page?.limit === 'number' ? page.limit : undefined,
        offset: typeof page?.offset === 'number' ? page.offset : undefined,
        after: typeof page?.after === 'string' ? page.after : undefined,
        before: typeof page?.before === 'string' ? page.before : undefined,
        includeTotal: typeof page?.includeTotal === 'boolean' ? page.includeTotal : undefined,
        select: Array.isArray((query as any).select) ? (query as any).select : undefined
    }
}
