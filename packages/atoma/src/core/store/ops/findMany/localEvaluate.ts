import { applyQuery } from '../../../query'
import type { StoreIndexes } from '../../../indexes/StoreIndexes'
import type { QueryMatcherOptions } from '../../../query/QueryMatcher'
import type { FindManyOptions, Entity } from '../../../types'
import type { EntityId } from '#protocol'
import type { Explain } from '#observability'
import { summarizeFindManyParams } from './paramsSummary'

export function evaluateWithIndexes<T extends Entity>(params: {
    mapRef: Map<EntityId, T>
    options?: FindManyOptions<T>
    indexes: StoreIndexes<T> | null
    matcher?: QueryMatcherOptions
    emit: (type: string, payload: any) => void
    explain?: Explain
}) {
    const { mapRef, options, indexes, matcher, emit, explain } = params

    const paramsSummary = summarizeFindManyParams(options)
    const candidateRes = indexes ? indexes.collectCandidates(options?.where) : { kind: 'unsupported' as const }
    const plan = indexes?.getLastQueryPlan()

    emit('query:index', {
        params: { whereFields: paramsSummary.whereFields },
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
        return [] as T[]
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

    const shouldSkipWhere =
        candidateRes.kind === 'candidates'
        && candidateRes.exactness === 'exact'
        && options?.where
        && typeof options.where === 'object'
        && typeof options.where !== 'function'

    const effectiveOptions = shouldSkipWhere
        ? ({ ...(options as any), where: undefined } as any)
        : options

    const shouldSkipApplyQuery =
        effectiveOptions
        && !effectiveOptions.where
        && !effectiveOptions.orderBy
        && effectiveOptions.limit === undefined
        && effectiveOptions.offset === undefined

    const out = shouldSkipApplyQuery
        ? (source as any as T[])
        : (applyQuery(source as any, effectiveOptions, { preSorted: false, matcher }) as T[])

    emit('query:finalize', { inputCount: source.length, outputCount: out.length, params: paramsSummary })
    if (explain) {
        ;(explain as any).finalize = { inputCount: source.length, outputCount: out.length, paramsSummary }
    }

    return out
}
