import type { FilterExpr, PageSpec, Query, SortRule } from 'atoma-types/core'

export type NormalizedQuery = {
    filter?: FilterExpr
    sort: SortRule[]
    page?: PageSpec
    select?: string[]
}

export function normalizeQuery(input: Query): NormalizedQuery {
    const sort = normalizeSort(input.sort)
    return {
        ...(input.filter ? { filter: input.filter } : {}),
        sort,
        ...(input.page ? { page: input.page } : {}),
        ...(input.select ? { select: normalizeSelect(input.select) } : {})
    }
}

export function normalizeSort(sort?: SortRule[]): SortRule[] {
    const base = Array.isArray(sort) && sort.length ? sort.slice() : [{ field: 'id', dir: 'asc' as const }]
    const hasId = base.some(rule => rule.field === 'id')
    return hasId ? base : [...base, { field: 'id', dir: 'asc' as const }]
}

function normalizeSelect(select: string[]): string[] {
    const output = select.filter(field => typeof field === 'string' && field) as string[]
    return output.length ? output : []
}
