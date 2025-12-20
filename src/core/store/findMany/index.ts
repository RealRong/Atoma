import { BaseStore } from '../../BaseStore'
import { createTraceId } from '../../../observability/trace'
import type { Explain } from '../../../observability/types'
import type { Entity, FindManyOptions, FindManyResult, PartialWithId, StoreKey } from '../../types'
import { commitAtomMapUpdate } from '../cacheWriter'
import { resolveCachePolicy } from './cachePolicy'
import { evaluateWithIndexes } from './localEvaluate'
import { normalizeFindManyResult } from './normalize'
import { summarizeFindManyParams } from './paramsSummary'
import { applyQuery } from '../../query'
import { type StoreRuntime, resolveObservabilityContext } from '../runtime'

export function createFindMany<T extends Entity>(runtime: StoreRuntime<T>) {
    const { jotaiStore, atom, adapter, context, indexes, matcher, transform } = runtime

    const preserveReference = (incoming: T): T => {
        const existing = jotaiStore.get(atom).get((incoming as any).id)
        if (!existing) return incoming

        const keys = new Set([...Object.keys(existing as any), ...Object.keys(incoming as any)])
        for (const key of keys) {
            if ((existing as any)[key] !== (incoming as any)[key]) {
                return incoming
            }
        }
        return existing
    }

    return async (options?: FindManyOptions<T>): Promise<FindManyResult<T>> => {
        const explainEnabled = options?.explain === true
        const cachePolicy = resolveCachePolicy(options)

        const observabilityContext = resolveObservabilityContext(runtime, options)
        const traceId = observabilityContext.traceId

        const optionsForAdapter = options
            ? ({ ...options, traceId: undefined, explain: undefined } as any as FindManyOptions<T>)
            : options

        const explain: Explain | undefined = explainEnabled
            ? { schemaVersion: 1, traceId: traceId || createTraceId() }
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

        if (typeof adapter.findMany === 'function') {
            try {
                const startedAt = Date.now()
                const raw = await adapter.findMany(optionsForAdapter, observabilityContext)
                const durationMs = Date.now() - startedAt
                const normalized = normalizeFindManyResult<T>(raw)
                const { data, pageInfo, explain: adapterExplain } = normalized

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
                            ...(adapterExplain !== undefined ? { explain: adapterExplain } : {})
                        },
                        {
                            cacheWrite: { writeToCache: false, reason: cachePolicy.reason },
                            adapter: { ok: true, durationMs },
                            ...(adapterExplain !== undefined ? { adapterRemoteExplain: adapterExplain } : {})
                        }
                    )
                }

                const existingMap = jotaiStore.get(atom) as Map<StoreKey, T>
                const next = new Map(existingMap)
                const processed = transformed.map(item => preserveReference(item))

                processed.forEach((item: T) => {
                    const id = (item as any).id as StoreKey
                    next.set(id, item)
                })

                commitAtomMapUpdate({
                    jotaiStore,
                    atom,
                    before: existingMap,
                    after: next,
                    context,
                    indexes
                })

                emit('query:cacheWrite', { writeToCache: true, params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields } })
                return withExplain(
                    {
                        data: transformed,
                        pageInfo,
                        ...(adapterExplain !== undefined ? { explain: adapterExplain } : {})
                    },
                    {
                        cacheWrite: { writeToCache: true },
                        adapter: { ok: true, durationMs },
                        ...(adapterExplain !== undefined ? { adapterRemoteExplain: adapterExplain } : {})
                    }
                )
            } catch (error) {
                adapter.onError?.(error as Error, 'findMany')
                const err = error instanceof Error ? error : new Error(String(error))
                return withExplain(
                    { data: (localResult as any).data },
                    { errors: [{ kind: 'adapter', code: 'FIND_MANY_FAILED', message: err.message, traceId }] }
                )
            }
        }

        try {
            const adapterFilter = typeof options?.where === 'function' ? options.where : undefined

            let remote = await adapter.getAll(adapterFilter as any, observabilityContext)
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

            const withRemovals = BaseStore.bulkRemove(toRemove, existingMap)
            const next = BaseStore.bulkAdd(remote as PartialWithId<T>[], withRemovals)
            commitAtomMapUpdate({
                jotaiStore,
                atom,
                before: existingMap,
                after: next,
                context,
                indexes
            })

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
            adapter.onError?.(error as Error, 'findMany')
            return localResult
        }
    }
}
