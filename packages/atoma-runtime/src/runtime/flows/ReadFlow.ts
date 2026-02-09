import type { Entity, Query as StoreQuery, QueryOneResult, QueryResult, StoreReadOptions } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { toErrorWithFallback as toError } from 'atoma-shared'
import type { CoreRuntime, RuntimeRead, StoreHandle } from 'atoma-types/runtime'

export class ReadFlow implements RuntimeRead {
    private readonly runtime: CoreRuntime

    constructor(runtime: CoreRuntime) {
        this.runtime = runtime
    }

    private toQueryResult = <T extends Entity>(data: T[], pageInfo?: unknown): QueryResult<T> => {
        return pageInfo ? { data, pageInfo: pageInfo as QueryResult<T>['pageInfo'] } : { data }
    }

    private writebackOne = async <T extends Entity>(handle: StoreHandle<T>, input: unknown): Promise<T | undefined> => {
        return await this.runtime.transform.writeback(handle, input as T)
    }

    private writebackArray = async <T extends Entity>(handle: StoreHandle<T>, input: unknown[]): Promise<T[]> => {
        const output: T[] = []
        for (const item of input) {
            const processed = await this.writebackOne(handle, item)
            if (processed !== undefined) output.push(processed)
        }
        return output
    }

    private applyQueryWriteback = <T extends Entity>(handle: StoreHandle<T>, remote: T[]): T[] => {
        const existingMap = handle.state.getSnapshot() as Map<EntityId, T>
        const result = this.runtime.engine.mutation.upsertItems(existingMap, remote)

        if (result.after !== existingMap) {
            handle.state.commit({ before: existingMap, after: result.after })
        }

        return result.items
    }

    query = async <T extends Entity>(handle: StoreHandle<T>, input: StoreQuery<T>): Promise<QueryResult<T>> => {
        const runtime = this.runtime
        const { state } = handle
        const hooks = runtime.hooks

        hooks.emit.readStart({ handle, query: input })

        let localCache: { data: T[]; result: QueryResult<T> } | null = null
        const getLocalResult = (): { data: T[]; result: QueryResult<T> } => {
            if (localCache) return localCache

            const localResult = runtime.engine.query.evaluate({
                state,
                query: input
            })

            const result = this.toQueryResult(localResult.data, localResult.pageInfo)
            localCache = { data: localResult.data, result }
            return localCache
        }

        try {
            const startedAt = runtime.now()
            const { data, pageInfo } = await runtime.io.query(handle, input)
            const durationMs = runtime.now() - startedAt

            const fetched = Array.isArray(data) ? data : []
            const remote = await this.writebackArray(handle, fetched)

            const cachePolicy = decideQueryCacheWrite(input)
            if (cachePolicy.effectiveSkipStore) {
                const result = this.toQueryResult(remote, pageInfo)
                hooks.emit.readFinish({ handle, query: input, result, durationMs })
                return result
            }

            const processed = this.applyQueryWriteback(handle, remote)
            const result = this.toQueryResult(processed, pageInfo)
            hooks.emit.readFinish({ handle, query: input, result, durationMs })
            return result
        } catch (error) {
            void toError(error, '[Atoma] query failed')
            const fallback = getLocalResult().result
            hooks.emit.readFinish({ handle, query: input, result: fallback })
            return fallback
        }
    }

    queryOne = async <T extends Entity>(handle: StoreHandle<T>, input: StoreQuery<T>): Promise<QueryOneResult<T>> => {
        const next: StoreQuery<T> = {
            ...input,
            page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
        }
        const result = await this.query(handle, next)
        return { data: result.data[0] }
    }

    getMany = async <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], cache = true, _options?: StoreReadOptions): Promise<T[]> => {
        const beforeMap = handle.state.getSnapshot() as Map<EntityId, T>
        const output: Array<T | undefined> = new Array(ids.length)
        const missingSet = new Set<EntityId>()
        const missingUnique: EntityId[] = []

        for (let index = 0; index < ids.length; index++) {
            const id = ids[index]
            const cached = beforeMap.get(id)
            if (cached !== undefined) {
                output[index] = cached
                continue
            }
            output[index] = undefined
            if (!missingSet.has(id)) {
                missingSet.add(id)
                missingUnique.push(id)
            }
        }

        if (missingUnique.length) {
            const { data } = await this.runtime.io.query(handle, {
                filter: { op: 'in', field: 'id', values: missingUnique }
            })

            const before = handle.state.getSnapshot() as Map<EntityId, T>
            const fetchedById = new Map<EntityId, T>()
            const itemsToCache: T[] = []

            for (const rawItem of data) {
                if (rawItem === undefined) continue
                const processed = await this.writebackOne(handle, rawItem)
                if (!processed) continue

                const id = processed.id
                const existing = before.get(id)
                const preserved = this.runtime.engine.mutation.preserveRef(existing, processed)

                fetchedById.set(id, preserved)
                if (cache) itemsToCache.push(preserved)
            }

            if (cache && itemsToCache.length) {
                const after = this.runtime.engine.mutation.addMany(itemsToCache, before)
                if (after !== before) {
                    handle.state.commit({ before, after })
                }
            }

            for (let index = 0; index < ids.length; index++) {
                if (output[index] !== undefined) continue
                const id = ids[index]
                output[index] = fetchedById.get(id)
            }
        }

        return output.filter((item): item is T => item !== undefined)
    }

    getOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, _options?: StoreReadOptions): Promise<T | undefined> => {
        const cached = handle.state.getSnapshot().get(id)
        if (cached !== undefined) return cached
        const items = await this.getMany(handle, [id], true)
        return items[0]
    }

    fetchOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId, _options?: StoreReadOptions): Promise<T | undefined> => {
        const { data } = await this.runtime.io.query(handle, {
            filter: { op: 'eq', field: 'id', value: id },
            page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
        })
        const one = data[0]
        if (one === undefined) return undefined
        return await this.writebackOne(handle, one)
    }

    fetchAll = async <T extends Entity>(handle: StoreHandle<T>, _options?: StoreReadOptions): Promise<T[]> => {
        const { data } = await this.runtime.io.query(handle, {})
        return await this.writebackArray(handle, data)
    }

    getAll = async <T extends Entity>(
        handle: StoreHandle<T>,
        filter?: (item: T) => boolean,
        cacheFilter?: (item: T) => boolean,
        _options?: StoreReadOptions
    ): Promise<T[]> => {
        const existingMap = handle.state.getSnapshot() as Map<EntityId, T>
        const { data } = await this.runtime.io.query(handle, {})
        const fetched = Array.isArray(data) ? data : []
        const output: T[] = []
        const itemsToCache: T[] = []
        const incomingIds = new Set<EntityId>()

        for (const rawItem of fetched) {
            const processed = await this.writebackOne(handle, rawItem)
            if (!processed) continue
            if (filter && !filter(processed)) continue

            const id = processed.id
            incomingIds.add(id)

            const shouldCache = cacheFilter ? cacheFilter(processed) : true
            if (!shouldCache) {
                output.push(processed)
                continue
            }

            const existing = existingMap.get(id)
            const preserved = this.runtime.engine.mutation.preserveRef(existing, processed)
            itemsToCache.push(preserved)
            output.push(preserved)
        }

        const toRemove: EntityId[] = []
        existingMap.forEach((_value, id) => {
            if (!incomingIds.has(id)) toRemove.push(id)
        })

        const withRemovals = this.runtime.engine.mutation.removeMany(toRemove, existingMap)
        const next = itemsToCache.length
            ? this.runtime.engine.mutation.addMany(itemsToCache, withRemovals)
            : withRemovals

        handle.state.commit({ before: existingMap, after: next })
        return output
    }
}

const decideQueryCacheWrite = <T extends Entity>(query?: StoreQuery<T>) => {
    const hasSelect = Boolean(Array.isArray(query?.select) && query.select.length)
    if (hasSelect) {
        return { effectiveSkipStore: true, reason: 'select' }
    }

    const include = query?.include
    const hasInclude = Boolean(include && typeof include === 'object' && Object.keys(include).length)
    if (hasInclude) {
        return { effectiveSkipStore: true, reason: 'include' }
    }

    return { effectiveSkipStore: false }
}
