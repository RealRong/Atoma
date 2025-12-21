import { applyQuery } from '../../query'
import type { StoreIndexes } from '../../indexes/StoreIndexes'
import type { QueryMatcherOptions } from '../../query/QueryMatcher'
import type { FindManyOptions, Entity, StoreKey } from '../../types'
import type { Explain } from '#observability'
import { summarizeFindManyParams } from './paramsSummary'

export function evaluateWithIndexes<T extends Entity>(params: {
    mapRef: Map<StoreKey, T>
    options?: FindManyOptions<T>
    indexes: StoreIndexes<T> | null
    matcher?: QueryMatcherOptions
    emit: (type: string, payload: any) => void
    explain?: Explain
}) {
    const { mapRef, options, indexes, matcher, emit, explain } = params

    const candidateRes = indexes ? indexes.collectCandidates(options?.where) : { kind: 'unsupported' as const }
    const plan = indexes?.getLastQueryPlan()

    emit('query:index', {
        params: { whereFields: summarizeFindManyParams(options).whereFields },
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
        emit('query:finalize', { inputCount: 0, outputCount: 0, params: summarizeFindManyParams(options) })
        if (explain) {
            ;(explain as any).finalize = { inputCount: 0, outputCount: 0, paramsSummary: summarizeFindManyParams(options) }
        }
        return [] as T[]
    }

    const source =
        candidateRes.kind === 'candidates'
            ? Array.from(candidateRes.ids).map(id => mapRef.get(id) as T).filter(Boolean)
            : Array.from(mapRef.values()) as T[]

    const out = applyQuery(source as any, options, { preSorted: false, matcher }) as T[]

    emit('query:finalize', { inputCount: source.length, outputCount: out.length, params: summarizeFindManyParams(options) })
    if (explain) {
        ;(explain as any).finalize = { inputCount: source.length, outputCount: out.length, paramsSummary: summarizeFindManyParams(options) }
    }

    return out
}
