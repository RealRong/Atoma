import { Observability } from '#observability'
import type { Explain } from '#observability'
import type { CoreRuntime, Entity, Query, QueryResult, QueryOneResult } from '../../../types'
import type { EntityId } from '#protocol'
import { toErrorWithFallback as toError } from '#shared'
import { evaluateWithIndexes } from './localEvaluate'
import { summarizeQuery } from './paramsSummary'
import { resolveObservabilityContext } from '../../internals/storeHandleManager'
import type { StoreHandle } from '../../internals/handleTypes'
import { StoreStateWriter } from '../../internals/StoreStateWriter'
import { StoreWriteUtils } from '../../internals/StoreWriteUtils'

export function createQuery<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    const { jotaiStore, atom, indexes, matcher } = handle
    const stateWriter = new StoreStateWriter(handle)

    return async (query: Query<T>): Promise<QueryResult<T>> => {
        const explainEnabled = query?.explain === true
        const observabilityContext = resolveObservabilityContext(clientRuntime, handle, query)

        const explain: Explain | undefined = explainEnabled
            ? { schemaVersion: 1, traceId: observabilityContext.traceId || Observability.trace.createId() }
            : undefined

        const emit = (type: string, payload: any) => observabilityContext.emit(type as any, payload)

        const withExplain = (out: any, extra?: any) => {
            if (!explainEnabled) return out
            return { ...out, explain: { ...explain, ...(extra || {}) } }
        }

        emit('query:start', { params: summarizeQuery(query) })

        let localCache: { data: T[]; result: QueryResult<T> } | null = null
        const getLocalResult = (): { data: T[]; result: QueryResult<T> } => {
            if (localCache) return localCache

            const map = jotaiStore.get(atom) as Map<EntityId, T>
            const localResult = evaluateWithIndexes({
                mapRef: map,
                query,
                indexes,
                matcher,
                emit,
                explain
            })

            const result = withExplain({ data: localResult.data, ...(localResult.pageInfo ? { pageInfo: localResult.pageInfo } : {}) })
            localCache = { data: localResult.data, result }
            return localCache
        }

        const shouldEagerEvaluateLocal = (explainEnabled || observabilityContext.active)
        if (shouldEagerEvaluateLocal) getLocalResult()

        try {
            const startedAt = Date.now()
            const { data, pageInfo } = await clientRuntime.io.query(handle, query, observabilityContext)
            const durationMs = Date.now() - startedAt

            const fetched = Array.isArray(data) ? data : []
            const remote: T[] = []
            for (let i = 0; i < fetched.length; i++) {
                const processed = await clientRuntime.transform.writeback(handle, fetched[i] as T)
                if (processed !== undefined) {
                    remote.push(processed)
                }
            }

            const shouldWriteToStore = !(Array.isArray((query as any)?.select) && (query as any).select.length)
            if (!shouldWriteToStore) {
                return withExplain(
                    { data: remote, ...(pageInfo ? { pageInfo: pageInfo as any } : {}) },
                    { dataSource: { ok: true, durationMs } }
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
                const preserved = StoreWriteUtils.preserveReferenceShallow(existing, item)
                processed[i] = preserved
                if (existing === preserved) continue
                changedIds.add(id)
                if (!next) next = new Map(existingMap)
                next.set(id, preserved)
            }

            if (next && changedIds.size) {
                stateWriter.commitMapUpdateDelta({
                    before: existingMap,
                    after: next,
                    changedIds
                })
            }

            return withExplain(
                { data: processed, ...(pageInfo ? { pageInfo: pageInfo as any } : {}) },
                { dataSource: { ok: true, durationMs } }
            )
        } catch (error) {
            void toError(error, '[Atoma] query failed')
            return getLocalResult().result
        }
    }
}

export function createQueryOne<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    const query = createQuery(clientRuntime, handle)
    return async (input: Query<T>): Promise<QueryOneResult<T>> => {
        const next: Query<T> = {
            ...input,
            page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
        }
        const res = await query(next)
        return { data: res.data[0], ...(res.explain ? { explain: res.explain } : {}) }
    }
}
