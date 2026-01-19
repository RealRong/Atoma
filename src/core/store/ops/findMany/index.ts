import { Observability } from '#observability'
import type { Explain } from '#observability'
import type { CoreRuntime, Entity, FindManyOptions, FindManyResult } from '../../../types'
import type { EntityId } from '#protocol'
import { toErrorWithFallback as toError } from '#shared'
import { storeWriteEngine } from '../../internals/storeWriteEngine'
import { resolveCachePolicy } from './cachePolicy'
import { evaluateWithIndexes } from './localEvaluate'
import { summarizeFindManyParams } from './paramsSummary'
import { applyQuery } from '../../../query'
import { storeHandleManager } from '../../internals/storeHandleManager'
import type { StoreHandle } from '../../internals/handleTypes'
import { executeQuery } from '../../../ops/opsExecutor'
import { normalizeAtomaServerQueryParams } from '../../internals/queryParams'

export function createFindMany<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    const { jotaiStore, atom, indexes, matcher } = handle

    return async (options?: FindManyOptions<T>): Promise<FindManyResult<T>> => {
        const explainEnabled = options?.explain === true
        const cachePolicy = resolveCachePolicy(options)

        const observabilityContext = storeHandleManager.resolveObservabilityContext(clientRuntime, handle, options)

        const optionsForRemote = options
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

            const map = jotaiStore.get(atom) as Map<EntityId, T>
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

        const shouldEagerEvaluateLocal = (explainEnabled || observabilityContext.active)
        if (shouldEagerEvaluateLocal) getLocalResult()

        try {
            const whereIsFn = typeof (options as any)?.where === 'function'
            const params = whereIsFn ? {} : normalizeAtomaServerQueryParams(optionsForRemote)
            const startedAt = Date.now()
            const { data, pageInfo } = await executeQuery(clientRuntime, handle, params, observabilityContext)
            const durationMs = Date.now() - startedAt

            const fetched = Array.isArray(data) ? data : []
            const remote: T[] = []
            for (let i = 0; i < fetched.length; i++) {
                const processed = await clientRuntime.dataProcessor.writeback(handle, fetched[i] as T)
                if (processed !== undefined) {
                    remote.push(processed)
                }
            }

            if (cachePolicy.effectiveSkipStore) {
                emit('query:cacheWrite', {
                    writeToCache: false,
                    reason: cachePolicy.reason,
                    params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields }
                })

                if (whereIsFn) {
                    return withExplain(
                        { data: applyQuery(remote as any, options as any, { matcher }) as T[] },
                        { cacheWrite: { writeToCache: false, reason: cachePolicy.reason }, dataSource: { ok: true, durationMs } }
                    )
                }

                return withExplain(
                    { data: remote, pageInfo: pageInfo as any },
                    { cacheWrite: { writeToCache: false, reason: cachePolicy.reason }, dataSource: { ok: true, durationMs } }
                )
            }

            const existingMap = jotaiStore.get(atom) as Map<EntityId, T>
            const changedIds = new Set<EntityId>()
            let next: Map<EntityId, T> | null = null
            const processed: T[] = new Array(remote.length)

            for (let i = 0; i < remote.length; i++) {
                const item = remote[i] as T
                const id = (item as any).id as EntityId
                const existing = existingMap.get(id)
                const preserved = storeWriteEngine.preserveReferenceShallow(existing, item)
                processed[i] = preserved
                if (existing === preserved) continue
                changedIds.add(id)
                if (!next) next = new Map(existingMap)
                next.set(id, preserved)
            }

            if (next && changedIds.size) {
                storeWriteEngine.commitAtomMapUpdateDelta({
                    handle,
                    before: existingMap,
                    after: next,
                    changedIds
                })
            }

            emit('query:cacheWrite', { writeToCache: true, params: { skipStore: Boolean(options?.skipStore), fields: (options as any)?.fields } })

            if (whereIsFn) {
                const mapRef = next ?? existingMap
                return withExplain(
                    {
                        data: evaluateWithIndexes({
                            mapRef,
                            options,
                            indexes,
                            matcher,
                            emit,
                            explain
                        })
                    },
                    { cacheWrite: { writeToCache: true }, dataSource: { ok: true, durationMs } }
                )
            }

            return withExplain(
                { data: processed, pageInfo: pageInfo as any },
                { cacheWrite: { writeToCache: true }, dataSource: { ok: true, durationMs } }
            )
        } catch (error) {
            const err = toError(error, '[Atoma] findMany failed')
            return getLocalResult().result
        }
    }
}
