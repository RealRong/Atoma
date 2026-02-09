import type { PageInfo, Query } from 'atoma-types/core'
import { matchesFilter } from './internal/filter'
import { normalizeQuery } from './internal/normalize'
import { applyPage } from './internal/page'
import { projectSelect } from './internal/select'
import { compareBy } from './internal/sort'

export function queryItems<T extends object>(
    items: T[],
    query: Query<T>
): { data: T[]; pageInfo?: PageInfo } {
    const normalized = normalizeQuery(query)
    const filter = normalized.filter

    const filtered = filter
        ? items.filter(item => matchesFilter(item, filter))
        : items.slice()

    const sorted = filtered.slice().sort(compareBy(normalized.sort))

    if (!normalized.page) {
        return { data: projectSelect(sorted, normalized.select) }
    }

    const paged = applyPage(sorted, normalized.page, normalized.sort)
    return {
        data: projectSelect(paged.data, normalized.select),
        pageInfo: paged.pageInfo
    }
}
