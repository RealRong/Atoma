import { executeLocalQuery } from '../../../query'
import type { StoreIndexes } from '../../../indexes/StoreIndexes'
import type { QueryMatcherOptions } from '../../../query/QueryMatcher'
import type { Query, Entity } from '../../../types'
import type { EntityId } from '#protocol'
import type { Explain } from '#observability'
import { summarizeQuery } from './paramsSummary'

export function evaluateWithIndexes<T extends Entity>(params: {
    mapRef: Map<EntityId, T>
    query: Query<T>
    indexes: StoreIndexes<T> | null
    matcher?: QueryMatcherOptions
    emit: (type: string, payload: any) => void
    explain?: Explain
}): { data: T[]; pageInfo?: any } {
    const { mapRef, query, indexes, matcher, emit, explain } = params

    const paramsSummary = summarizeQuery(query)
    const candidateRes = indexes ? indexes.collectCandidates(query?.filter as any) : { kind: 'unsupported' as const }
    const plan = indexes?.getLastQueryPlan()

    emit('query:index', {
        params: { filterFields: paramsSummary.filterFields },
        result: candidateRes.kind === 'candidates'
            ? { kind: 'candidates', exactness: candidateRes.exactness, count: candidateRes.ids.size }
            : { kind: candidateRes.kind },
        plan
    })

    if (explain) {
        ;(explain as any).index = {
            kind: candidateRes.kind,
            ...(candidateRes.kind === 'candidates' ? { exactness: candidateRes.exactness, candidates: candidateRes.ids.size } : {}),
            ...(plan ? { lastQueryPlan: plan } : {})
        }
    }

    if (candidateRes.kind === 'empty') {
        emit('query:finalize', { inputCount: 0, outputCount: 0, params: paramsSummary })
        if (explain) {
            ;(explain as any).finalize = { inputCount: 0, outputCount: 0, paramsSummary }
        }
        return { data: [] }
    }

    const source =
        candidateRes.kind === 'candidates'
            ? (() => {
                const out: T[] = []
                for (const id of candidateRes.ids) {
                    const item = mapRef.get(id)
                    if (item !== undefined) out.push(item)
                }
                return out
            })()
            : Array.from(mapRef.values()) as T[]

    const effectiveQuery =
        candidateRes.kind === 'candidates'
        && candidateRes.exactness === 'exact'
        && query?.filter
            ? ({ ...query, filter: undefined } as Query<T>)
            : query

    const out = executeLocalQuery(source as any, effectiveQuery as any, { preSorted: false, matcher })

    emit('query:finalize', { inputCount: source.length, outputCount: out.data.length, params: paramsSummary })
    if (explain) {
        ;(explain as any).finalize = { inputCount: source.length, outputCount: out.data.length, paramsSummary }
    }

    return out as any
}
