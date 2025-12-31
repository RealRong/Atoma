import { Observability } from '#observability'
import type { Explain } from '#observability'
import type { Entity, FindManyOptions, FindManyResult, PartialWithId, StoreKey } from '../../../types'
import { bulkAdd, bulkRemove } from '../../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../../internals/cacheWriter'
import { toError } from '../../internals/errors'
import { preserveReferenceShallow } from '../../internals/preserveReference'
import { resolveCachePolicy } from './cachePolicy'
import { evaluateWithIndexes } from './localEvaluate'
import { normalizeFindManyResult } from './normalize'
import { summarizeFindManyParams } from './paramsSummary'
import { applyQuery } from '../../../query'
import { resolveObservabilityContext } from '../../internals/runtime'
import type { StoreHandle } from '../../../types'

export function createFindMany<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, dataSource, indexes, matcher, transform } = handle

    return async (options?: FindManyOptions<T>): Promise<FindManyResult<T>> => {
        const explainEnabled = options?.explain === true
        const cachePolicy = resolveCachePolicy(options)

        const observabilityContext = resolveObservabilityContext(handle, options)

        const optionsForDataSource = options
            ? ({ ...options, explain: undefined } as any as FindManyOptions<T>)
            : options

        const explain: Explain | undefined = explainEnabled
            ? { schemaVersion: 1, traceId: observabilityContext.traceId || Observability.trace.createId() }
            : undefined

        const emit = (type: string, payload: any) => observabilityContext.emit(type as any, payload)

        const withExplain = (out: any, extra?: any) => {
            if (!explainEnabled) return out
            return { ...out, explain: { ...explain, ...(extra || {}) } }
        }

        emit('query:start', { params: summarizeFindManyParams(options) })

        let localCache: { data: T[]; result: FindManyResult<T> } | null = null
        const getLocalResult = (): { data: T[]; result: FindManyResult<T> } => {
            if (localCache) return localCache

            const map = jotaiStore.get(atom) as Map<StoreKey, T>
            const localData = evaluateWithIndexes({
                mapRef: map,
                options,
                indexes,
                matcher,
                emit,
                explain
            })

            const localResult = withExplain(
                { data: localData },
                {
                    cacheWrite: {
                        writeToCache: !cachePolicy.effectiveSkipStore,
                        ...(cachePolicy.effectiveSkipStore ? { reason: cachePolicy.reason } : {})
                    }
                }
            )

            localCache = { data: localData, result: localResult }
            return localCache
        }

        const shouldEagerEvaluateLocal = typeof dataSource.findMany === 'function' && (explainEnabled || observabilityContext.active)
        if (shouldEagerEvaluateLocal) getLocalResult()

        if (typeof dataSource.findMany === 'function') {
            try {
                const startedAt = Date.now()
                const raw = await dataSource.findMany(optionsForDataSource, observabilityContext)
                const durationMs = Date.now() - startedAt
                const normalized = normalizeFindManyResult<T>(raw)
                const { data, pageInfo, explain: dataSourceExplain } = normalized

                const fetched = data || []

                if (cachePolicy.effectiveSkipStore) {
                    const transformed: T[] = new Array(fetched.length)
                    for (let i = 0; i < fetched.length; i++) {
                        transformed[i] = transform(fetched[i] as T)
                    }
                    emit('query:cacheWrite', {
                        writeToCache: false,
                        reason: cachePolicy.reason,
                        params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields }
                    })
                    return withExplain(
                        {
                            data: transformed,
                            pageInfo,
                            ...(dataSourceExplain !== undefined ? { explain: dataSourceExplain } : {})
                        },
                        {
                            cacheWrite: { writeToCache: false, reason: cachePolicy.reason },
                            dataSource: { ok: true, durationMs },
                            ...(dataSourceExplain !== undefined ? { dataSourceRemoteExplain: dataSourceExplain } : {})
                        }
                    )
                }

                const existingMap = jotaiStore.get(atom) as Map<StoreKey, T>
                const changedIds = new Set<StoreKey>()
                let next: Map<StoreKey, T> | null = null
                const processed: T[] = new Array(fetched.length)

                for (let i = 0; i < fetched.length; i++) {
                    const transformed = transform(fetched[i] as T)
                    const id = (transformed as any).id as StoreKey
                    const existing = existingMap.get(id)
                    const preserved = preserveReferenceShallow(existing, transformed)
                    processed[i] = preserved
                    if (existing === preserved) continue
                    changedIds.add(id)
                    if (!next) next = new Map(existingMap)
                    next.set(id, preserved)
                }

                if (next && changedIds.size) {
                    commitAtomMapUpdateDelta({
                        handle,
                        before: existingMap,
                        after: next,
                        changedIds
                    })
                }

                emit('query:cacheWrite', { writeToCache: true, params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields } })
                return withExplain(
                    {
                        data: processed,
                        pageInfo,
                        ...(dataSourceExplain !== undefined ? { explain: dataSourceExplain } : {})
                    },
                    {
                        cacheWrite: { writeToCache: true },
                        dataSource: { ok: true, durationMs },
                        ...(dataSourceExplain !== undefined ? { dataSourceRemoteExplain: dataSourceExplain } : {})
                    }
                )
            } catch (error) {
                const err = toError(error, '[Atoma] findMany failed')
                dataSource.onError?.(err, 'findMany')
                const { data: localData } = getLocalResult()
                return withExplain(
                    { data: localData },
                    { errors: [{ kind: 'datasource', code: 'FIND_MANY_FAILED', message: err.message, traceId: observabilityContext.traceId }] }
                )
            }
        }

        try {
            const dataSourceFilter = typeof options?.where === 'function' ? options.where : undefined

            let remote = await dataSource.getAll(dataSourceFilter as any, observabilityContext)
            remote = remote.map(item => transform(item))

            if (cachePolicy.effectiveSkipStore) {
                emit('query:cacheWrite', {
                    writeToCache: false,
                    reason: cachePolicy.reason,
                    params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields }
                })

                const anyWhere = (options as any)?.where
                const shouldSkipApplyQuery =
                    !options
                    || (
                        (!anyWhere || typeof anyWhere === 'function')
                        && !options.orderBy
                        && options.limit === undefined
                        && options.offset === undefined
                    )

                if (!shouldSkipApplyQuery) {
                    const effectiveOptions = typeof options?.where === 'function'
                        ? ({ ...(options as any), where: undefined } as any)
                        : options
                    return withExplain(
                        { data: applyQuery(remote as any, effectiveOptions, { matcher }) as T[] },
                        { cacheWrite: { writeToCache: false, reason: cachePolicy.reason } }
                    )
                }

                return withExplain(
                    { data: remote },
                    { cacheWrite: { writeToCache: false, reason: cachePolicy.reason } }
                )
            }

            const existingMap = jotaiStore.get(atom) as Map<StoreKey, T>
            const incomingIds = new Set<StoreKey>()
            const processed: T[] = new Array(remote.length)

            for (let i = 0; i < remote.length; i++) {
                const item = remote[i] as T
                const id = (item as any).id as StoreKey
                incomingIds.add(id)
                const existing = existingMap.get(id)
                processed[i] = preserveReferenceShallow(existing, item)
            }
            const toRemove: StoreKey[] = []
            existingMap.forEach((_value: T, id: StoreKey) => {
                if (!incomingIds.has(id)) toRemove.push(id)
            })

            const withRemovals = bulkRemove(toRemove, existingMap)
            const next = processed.length
                ? bulkAdd(processed as PartialWithId<T>[], withRemovals)
                : withRemovals

            const changedIds = new Set<StoreKey>(toRemove)
            for (let i = 0; i < processed.length; i++) {
                const id = (processed[i] as any).id as StoreKey
                if (!existingMap.has(id) || existingMap.get(id) !== processed[i]) {
                    changedIds.add(id)
                }
            }

            commitAtomMapUpdateDelta({ handle, before: existingMap, after: next, changedIds })

            emit('query:cacheWrite', { writeToCache: true, params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields } })
            const effectiveOptions = typeof options?.where === 'function'
                ? ({ ...(options as any), where: undefined } as any)
                : options
            return withExplain(
                {
                    data: evaluateWithIndexes({
                        mapRef: next,
                        options: effectiveOptions,
                        indexes,
                        matcher,
                        emit,
                        explain
                    })
                },
                { cacheWrite: { writeToCache: true } }
            )
        } catch (error) {
            const err = toError(error, '[Atoma] findMany(getAll fallback) failed')
            dataSource.onError?.(err, 'findMany')
            return getLocalResult().result
        }
    }
}
