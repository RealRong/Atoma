import type { PageInfo, Query, QueryMatcherOptions } from 'atoma-types/core'
import { normalizeQuery } from './normalize'
import { matchesFilter } from './filter'
import { applyPage } from './page'
import { projectSelect } from './select'
import { compareBy } from './sort'

export type RunOptions = {
    preSorted?: boolean
    matcher?: QueryMatcherOptions
}

export function runQuery<T extends object>(
    items: T[],
    query: Query<T>,
    options?: RunOptions
): { data: T[]; pageInfo?: PageInfo } {
    const normalized = normalizeQuery(query)

    const filter = normalized.filter

    const filtered = filter
        ? items.filter(item => matchesFilter(item, filter, options?.matcher))
        : items.slice()

    const sorted = options?.preSorted
        ? filtered
        : filtered.slice().sort(compareBy(normalized.sort))

    if (!normalized.page) {
        return { data: projectSelect(sorted, normalized.select) }
    }

    const paged = applyPage(sorted, normalized.page, normalized.sort)
    return {
        data: projectSelect(paged.data, normalized.select),
        pageInfo: paged.pageInfo
    }
}
