import type { Entity, IndexesLike, PageInfo, Query } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import { matchesFilter } from './internal/filter'
import { normalizeQuery } from './internal/normalize'
import { applyPage } from './internal/page'
import { projectSelect } from './internal/select'
import { compareBy } from './internal/sort'

export function runQuery<T extends Entity>(args: {
    snapshot: ReadonlyMap<EntityId, T>
    query: Query<T>
    indexes: IndexesLike<T> | null
}): { data: T[]; pageInfo?: PageInfo } {
    const { snapshot, query, indexes } = args

    const candidateResult = indexes ? indexes.collectCandidates(query.filter) : { kind: 'unsupported' as const }
    if (candidateResult.kind === 'empty') {
        return { data: [] }
    }

    const source = candidateResult.kind === 'candidates'
        ? (() => {
            const output: T[] = []
            for (const id of candidateResult.ids) {
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
        return { data: projectSelect(sorted, normalized.select) as T[] }
    }

    const paged = applyPage(sorted, normalized.page, normalized.sort)
    return {
        data: projectSelect(paged.data, normalized.select) as T[],
        pageInfo: paged.pageInfo
    }
}
