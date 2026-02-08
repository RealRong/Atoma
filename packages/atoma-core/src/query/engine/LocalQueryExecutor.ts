import type { PageInfo, Query, QueryMatcherOptions } from 'atoma-types/core'
import { normalizeQuery } from '../normalize'
import { matchesFilter } from './filterEvaluator'
import { applyPage } from './pageEngine'
import { projectSelect } from './selectionProjector'
import { compareBy } from './sortEngine'

export type ExecuteOptions = {
    preSorted?: boolean
    matcher?: QueryMatcherOptions
}

export class LocalQueryExecutor<T extends object> {
    constructor(
        private readonly items: T[],
        private readonly query: Query,
        private readonly options?: ExecuteOptions
    ) {}

    execute(): { data: T[]; pageInfo?: PageInfo } {
        const normalized = normalizeQuery(this.query)

        const filtered = normalized.filter
            ? this.items.filter(item => matchesFilter(item, normalized.filter!, this.options?.matcher))
            : this.items.slice()

        const sorted = this.options?.preSorted
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
}
