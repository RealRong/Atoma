import type { FilterExpr, PageSpec, Query, SortRule } from 'atoma-types/core'

export type NormalizedQuery = {
    filter?: FilterExpr
    sort: SortRule[]
    page?: PageSpec
}

export function normalizeQuery(input: Query): NormalizedQuery {
    const sort = normalizeSort(input.sort)
    return {
        ...(input.filter ? { filter: input.filter } : {}),
        sort,
        ...(input.page ? { page: input.page } : {})
    }
}

export function normalizeSort(sort?: SortRule[]): SortRule[] {
    const base = Array.isArray(sort) && sort.length ? sort.slice() : [{ field: 'id', dir: 'asc' as const }]
    const hasId = base.some(rule => rule.field === 'id')
    return hasId ? base : [...base, { field: 'id', dir: 'asc' as const }]
}
