import { Query, Store } from 'atoma-core'
import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { toErrorWithFallback as toError } from 'atoma-shared'
import type { CoreRuntime, RuntimeRead, StoreHandle } from 'atoma-types/runtime'

export class ReadFlow implements RuntimeRead {
    private runtime: CoreRuntime

    constructor(runtime: CoreRuntime) {
        this.runtime = runtime
    }

    query = async <T extends Types.Entity>(handle: StoreHandle<T>, input: Types.Query<T>): Promise<Types.QueryResult<T>> => {
        const runtime = this.runtime
        const { jotaiStore, atom, indexes, matcher } = handle
        const hooks = runtime.hooks

        hooks.emit.readStart({ handle, query: input })

        let localCache: { data: T[]; result: Types.QueryResult<T> } | null = null
        const getLocalResult = (): { data: T[]; result: Types.QueryResult<T> } => {
            if (localCache) return localCache

            const map = jotaiStore.get(atom) as Map<EntityId, T>
            const localResult = Query.evaluateWithIndexes({
                mapRef: map,
                query: input,
                indexes,
                matcher
            })

            const result = { data: localResult.data, ...(localResult.pageInfo ? { pageInfo: localResult.pageInfo } : {}) }
            localCache = { data: localResult.data, result }
            return localCache
        }

        try {
            const startedAt = Date.now()
            const { data, pageInfo } = await runtime.io.query(handle, input)
            const durationMs = Date.now() - startedAt

            const fetched = Array.isArray(data) ? data : []
            const remote: T[] = []
            for (let i = 0; i < fetched.length; i++) {
                const processed = await runtime.transform.writeback(handle, fetched[i] as T)
                if (processed !== undefined) {
                    remote.push(processed)
                }
            }

            const cachePolicy = Query.resolveCachePolicy(input)
            if (cachePolicy.effectiveSkipStore) {
                const result = { data: remote, ...(pageInfo ? { pageInfo: pageInfo as any } : {}) }
                hooks.emit.readFinish({ handle, query: input, result, durationMs })
                return result
            }

            const existingMap = jotaiStore.get(atom) as Map<EntityId, T>
            const changedIds = new Set<EntityId>()
            let next: Map<EntityId, T> | null = null
            const processed: T[] = new Array(remote.length)

            for (let i = 0; i < remote.length; i++) {
                const item = remote[i] as T
                const id = (item as any).id as EntityId
                const existing = existingMap.get(id)
                const preserved = Store.preserveReferenceShallow(existing, item)
                processed[i] = preserved
                if (existing === preserved) continue
                changedIds.add(id)
                if (!next) next = new Map(existingMap)
                next.set(id, preserved)
            }

            if (next && changedIds.size) {
                handle.stateWriter.commitMapUpdateDelta({
                    before: existingMap,
                    after: next,
                    changedIds
                })
            }

            const result = { data: processed, ...(pageInfo ? { pageInfo: pageInfo as any } : {}) }
            hooks.emit.readFinish({ handle, query: input, result, durationMs })
            return result
        } catch (error) {
            void toError(error, '[Atoma] query failed')
            const fallback = getLocalResult().result
            hooks.emit.readFinish({ handle, query: input, result: fallback })
            return fallback
        }
    }

    queryOne = async <T extends Types.Entity>(handle: StoreHandle<T>, input: Types.Query<T>): Promise<Types.QueryOneResult<T>> => {
        const next: Types.Query<T> = {
            ...input,
            page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
        }
        const res = await this.query(handle, next)
        return { data: res.data[0] }
    }

    getMany = async <T extends Types.Entity>(handle: StoreHandle<T>, ids: EntityId[], cache = true, options?: Types.StoreReadOptions): Promise<T[]> => {
        const runtime = this.runtime
        const { jotaiStore, atom } = handle

        const beforeMap = jotaiStore.get(atom) as Map<EntityId, T>
        const out: Array<T | undefined> = new Array(ids.length)
        const missingSet = new Set<EntityId>()
        const missingUnique: EntityId[] = []

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i]
            const cached = beforeMap.get(id)
            if (cached !== undefined) {
                out[i] = cached
                continue
            }
            out[i] = undefined
            if (!missingSet.has(id)) {
                missingSet.add(id)
                missingUnique.push(id)
            }
        }

        if (missingUnique.length) {
            const { data } = await runtime.io.query(handle, {
                filter: { op: 'in', field: 'id', values: missingUnique }
            })

            const before = jotaiStore.get(atom) as Map<EntityId, T>
            const fetchedById = new Map<EntityId, T>()
            const itemsToCache: T[] = []

            for (const got of data) {
                if (got === undefined) continue
                const processed = await runtime.transform.writeback(handle, got as T)
                if (!processed) continue
                const id = (processed as any).id as EntityId

                const existing = before.get(id)
                const preserved = Store.preserveReferenceShallow(existing, processed)

                fetchedById.set(id, preserved)
                if (cache) {
                    itemsToCache.push(preserved)
                }
            }

            if (cache && itemsToCache.length) {
                const after = Store.bulkAdd(itemsToCache as any, before)
                if (after !== before) {
                    const changedIds = new Set<EntityId>()
                    for (const item of itemsToCache) {
                        const id = (item as any).id as EntityId
                        if (!before.has(id) || before.get(id) !== item) {
                            changedIds.add(id)
                        }
                    }
                    handle.stateWriter.commitMapUpdateDelta({ before, after, changedIds })
                }
            }

            for (let i = 0; i < ids.length; i++) {
                if (out[i] !== undefined) continue
                const id = ids[i]
                out[i] = fetchedById.get(id)
            }
        }

        return out.filter((i): i is T => i !== undefined)
    }

    getOne = async <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, options?: Types.StoreReadOptions): Promise<T | undefined> => {
        const { jotaiStore, atom } = handle
        const cached = jotaiStore.get(atom).get(id)
        if (cached !== undefined) return cached
        const items = await this.getMany(handle, [id], true, options)
        return items[0]
    }

    fetchOne = async <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, options?: Types.StoreReadOptions): Promise<T | undefined> => {
        const runtime = this.runtime
        const { data } = await runtime.io.query(handle, {
            filter: { op: 'eq', field: 'id', value: id },
            page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
        })
        const one = data[0]
        if (one === undefined) return undefined
        return await runtime.transform.writeback(handle, one as T)
    }

    fetchAll = async <T extends Types.Entity>(handle: StoreHandle<T>, options?: Types.StoreReadOptions): Promise<T[]> => {
        const runtime = this.runtime
        const { data } = await runtime.io.query(handle, {})
        const out: T[] = []
        for (let i = 0; i < data.length; i++) {
            const processed = await runtime.transform.writeback(handle, data[i] as T)
            if (processed !== undefined) {
                out.push(processed)
            }
        }
        return out
    }

    getAll = async <T extends Types.Entity>(handle: StoreHandle<T>, filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: Types.StoreReadOptions): Promise<T[]> => {
        const runtime = this.runtime
        const { jotaiStore, atom } = handle

        const existingMap = jotaiStore.get(atom) as Map<EntityId, T>
        const { data } = await runtime.io.query(handle, {})
        const fetched = Array.isArray(data) ? data : []
        const arr: T[] = []
        const itemsToCache: Array<T> = []
        const incomingIds = new Set<EntityId>()

        for (let i = 0; i < fetched.length; i++) {
            const processed = await runtime.transform.writeback(handle, fetched[i] as T)
            if (!processed) continue
            if (filter && !filter(processed)) continue
            const id = (processed as any).id as EntityId
            incomingIds.add(id)

            const shouldCache = cacheFilter ? cacheFilter(processed) : true
            if (!shouldCache) {
                arr.push(processed)
                continue
            }

            const existing = existingMap.get(id)
            const preserved = Store.preserveReferenceShallow(existing, processed)
            itemsToCache.push(preserved as any)
            arr.push(preserved)
        }

        const toRemove: EntityId[] = []
        existingMap.forEach((_value: T, id: EntityId) => {
            if (!incomingIds.has(id)) toRemove.push(id)
        })

        const withRemovals = Store.bulkRemove(toRemove, existingMap)
        const next = itemsToCache.length
            ? Store.bulkAdd(itemsToCache as any, withRemovals)
            : withRemovals

        const changedIds = new Set<EntityId>(toRemove)
        for (const item of itemsToCache) {
            const id = (item as any).id as EntityId
            const beforeVal = existingMap.get(id)
            if (!existingMap.has(id) || beforeVal !== (item as any)) {
                changedIds.add(id)
            }
        }

        handle.stateWriter.commitMapUpdateDelta({ before: existingMap, after: next, changedIds })

        return arr
    }
}
