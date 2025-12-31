import { Observability } from '#observability'
import type { Explain } from '#observability'
import type { Entity, FindManyOptions, FindManyResult, PartialWithId, StoreKey } from '../../../types'
import { bulkAdd, bulkRemove } from '../../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../../internals/cacheWriter'
import { preserveReferenceShallow } from '../../internals/preserveReference'
import { resolveCachePolicy } from './cachePolicy'
import { evaluateWithIndexes } from './localEvaluate'
import { normalizeFindManyResult } from './normalize'
import { summarizeFindManyParams } from './paramsSummary'
import { applyQuery } from '../../../query'
import { resolveObservabilityContext } from '../../internals/runtime'
import type { StoreHandle } from '../../../types'

export function createFindMany<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, dataSource, services, indexes, matcher, transform } = handle

    const preserveReference = (incoming: T): T => {
        const existing = jotaiStore.get(atom).get((incoming as any).id)
        if (!existing) return incoming
        return preserveReferenceShallow(existing, incoming)
    }

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

        const map = jotaiStore.get(atom) as Map<StoreKey, T>
        emit('query:start', { params: summarizeFindManyParams(options) })

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

        if (typeof dataSource.findMany === 'function') {
            try {
                const startedAt = Date.now()
                const raw = await dataSource.findMany(optionsForDataSource, observabilityContext)
                const durationMs = Date.now() - startedAt
                const normalized = normalizeFindManyResult<T>(raw)
                const { data, pageInfo, explain: dataSourceExplain } = normalized

                const transformed = (data || []).map((item: T) => transform(item))

                if (cachePolicy.effectiveSkipStore) {
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

                const processed = transformed.map(item => preserveReference(item))

                const existingMap = jotaiStore.get(atom) as Map<StoreKey, T>
                const changedIds = new Set<StoreKey>()
                let next: Map<StoreKey, T> | null = null

                processed.forEach((item: T) => {
                    const id = (item as any).id as StoreKey
                    const prev = existingMap.get(id)
                    if (prev === item) return
                    changedIds.add(id)
                    if (!next) next = new Map(existingMap)
                    next.set(id, item)
                })

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
                        data: transformed,
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
                dataSource.onError?.(error as Error, 'findMany')
                const err = error instanceof Error ? error : new Error(String(error))
                return withExplain(
                    { data: (localResult as any).data },
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

                if (options?.where && typeof options.where !== 'function') {
                    return withExplain(
                        { data: applyQuery(remote as any, options, { matcher }) as T[] },
                        { cacheWrite: { writeToCache: false, reason: cachePolicy.reason } }
                    )
                }

                return withExplain(
                    { data: remote },
                    { cacheWrite: { writeToCache: false, reason: cachePolicy.reason } }
                )
            }

            remote = remote.map(item => preserveReference(item))

            const existingMap = jotaiStore.get(atom) as Map<StoreKey, T>
            const incomingIds = new Set(remote.map(item => (item as any).id as StoreKey))
            const toRemove: StoreKey[] = []
            existingMap.forEach((_value: T, id: StoreKey) => {
                if (!incomingIds.has(id)) toRemove.push(id)
            })

            const withRemovals = bulkRemove(toRemove, existingMap)
            const next = bulkAdd(remote as PartialWithId<T>[], withRemovals)
            const changedIds = new Set<StoreKey>(toRemove)
            incomingIds.forEach(id => changedIds.add(id))
            commitAtomMapUpdateDelta({ handle, before: existingMap, after: next, changedIds })

            emit('query:cacheWrite', { writeToCache: true, params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields } })
            return withExplain(
                {
                    data: evaluateWithIndexes({
                        mapRef: jotaiStore.get(atom),
                        options,
                        indexes,
                        matcher,
                        emit,
                        explain
                    })
                },
                { cacheWrite: { writeToCache: true } }
            )
        } catch (error) {
            dataSource.onError?.(error as Error, 'findMany')
            return localResult
        }
    }
}
