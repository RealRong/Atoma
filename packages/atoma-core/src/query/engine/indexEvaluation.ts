import type { Entity, Query, QueryMatcherOptions } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreIndexes } from '../../indexes/StoreIndexes'
import { summarizeQuery } from '../summary'
import { LocalQueryExecutor } from './LocalQueryExecutor'

export function evaluateWithIndexes<T extends Entity>(params: {
    mapRef: Map<EntityId, T>
    query: Query<T>
    indexes: StoreIndexes<T> | null
    matcher?: QueryMatcherOptions
    emit?: (type: string, payload: unknown) => void
}): { data: T[]; pageInfo?: unknown } {
    const { mapRef, query, indexes, matcher } = params
    const emit = params.emit ?? (() => {})

    const paramsSummary = summarizeQuery(query)
    const candidateRes = indexes ? indexes.collectCandidates(query?.filter) : { kind: 'unsupported' as const }
    const plan = indexes?.getLastQueryPlan()

    emit('query:index', {
        params: { filterFields: paramsSummary.filterFields },
        result: candidateRes.kind === 'candidates'
            ? { kind: 'candidates', exactness: candidateRes.exactness, count: candidateRes.ids.size }
            : { kind: candidateRes.kind },
        plan
    })

    if (candidateRes.kind === 'empty') {
        emit('query:finalize', { inputCount: 0, outputCount: 0, params: paramsSummary })
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

    const output = new LocalQueryExecutor(source, query as Query, { preSorted: false, matcher }).execute()

    emit('query:finalize', { inputCount: source.length, outputCount: output.data.length, params: paramsSummary })

    return output
}
