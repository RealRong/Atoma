import type { Entity, Indexes, PageInfo, Query } from '@atoma-js/types/core'
import type { EntityId } from '@atoma-js/types/shared'
import { matchesFilter } from './internal/filter'
import { normalizeQuery } from './internal/normalize'
import { applyPage } from './internal/page'
import { compareBy } from './internal/sort'

export function runQuery<T extends Entity>(args: {
    snapshot: ReadonlyMap<EntityId, T>
    query: Query<T>
    indexes: Indexes<T> | null
}): { data: T[]; pageInfo?: PageInfo } {
    const { snapshot, query, indexes } = args

    const hits = indexes ? indexes.query(query.filter) : { kind: 'scan' as const }
    if (hits.kind === 'hits' && hits.ids.size === 0) return { data: [] }

    const source = hits.kind === 'hits'
        ? (() => {
            const output: T[] = []
            for (const id of hits.ids) {
                const item = snapshot.get(id)
                if (item !== undefined) output.push(item)
            }
            return output
        })()
        : Array.from(snapshot.values())

    const normalized = normalizeQuery(query)
    const filter = normalized.filter
    const filtered = filter
        ? source.filter(item => matchesFilter(item, filter))
        : source.slice()

    const sorted = filtered.slice().sort(compareBy(normalized.sort))

    if (!normalized.page) {
        return { data: sorted }
    }

    const paged = applyPage(sorted, normalized.page, normalized.sort)
    return {
        data: paged.data,
        pageInfo: paged.pageInfo
    }
}
