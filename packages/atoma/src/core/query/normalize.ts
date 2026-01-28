import type { FilterExpr, PageSpec, Query, SortRule } from '#protocol'

export type NormalizedQuery = {
    filter?: FilterExpr
    sort: SortRule[]
    page?: PageSpec
    select?: string[]
    include?: Record<string, Query>
    explain?: boolean
}

export function normalizeQuery(input: Query): NormalizedQuery {
    const sort = normalizeSort(input.sort)
    return {
        ...(input.filter ? { filter: input.filter } : {}),
        sort,
        ...(input.page ? { page: input.page } : {}),
        ...(input.select ? { select: normalizeSelect(input.select) } : {}),
        ...(input.include ? { include: input.include } : {}),
        ...(typeof input.explain === 'boolean' ? { explain: input.explain } : {})
    }
}

export function normalizeSort(sort?: SortRule[]): SortRule[] {
    const base = Array.isArray(sort) && sort.length ? sort.slice() : [{ field: 'id', dir: 'asc' as const }]
    const hasId = base.some(r => r.field === 'id')
    return hasId ? base : [...base, { field: 'id', dir: 'asc' as const }]
}

function normalizeSelect(select: string[]): string[] {
    const out = select.filter(f => typeof f === 'string' && f) as string[]
    return out.length ? out : []
}
