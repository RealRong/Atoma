import type { Entity, IndexesLike, PageInfo, Query } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import { queryItems } from './queryItems'

export function queryMap<T extends Entity>(params: {
    mapRef: ReadonlyMap<EntityId, T>
    query: Query<T>
    indexes: IndexesLike<T> | null
}): { data: T[]; pageInfo?: PageInfo } {
    const { mapRef, query, indexes } = params

    const candidateRes = indexes ? indexes.collectCandidates(query.filter) : { kind: 'unsupported' as const }
    if (candidateRes.kind === 'empty') {
        return { data: [] }
    }

    const source =
        candidateRes.kind === 'candidates'
            ? (() => {
                const output: T[] = []
                for (const id of candidateRes.ids) {
                    const item = mapRef.get(id)
                    if (item !== undefined) output.push(item)
                }
                return output
            })()
            : Array.from(mapRef.values())

    return queryItems(source, query)
}
