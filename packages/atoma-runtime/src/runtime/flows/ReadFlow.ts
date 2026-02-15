import type {
    Entity,
    GetAllMergePolicy,
    Query as StoreQuery,
    QueryOneResult,
    QueryResult,
    StoreReadOptions
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import { toErrorWithFallback as toError } from 'atoma-shared'
import type { Runtime, Read, StoreHandle } from 'atoma-types/runtime'

export class ReadFlow implements Read {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    private toQueryResult = <T extends Entity>(data: T[], pageInfo?: unknown): QueryResult<T> => {
        return pageInfo ? { data, pageInfo: pageInfo as QueryResult<T>['pageInfo'] } : { data }
    }

    private resolveQueryRoute = <T extends Entity>(
        handle: StoreHandle<T>,
        options?: StoreReadOptions
    ) => {
        return options?.route ?? handle.config.defaultRoute
    }

    private toExecutionOptions = <T extends Entity>(
        handle: StoreHandle<T>,
        options?: StoreReadOptions
    ) => {
        const route = this.resolveQueryRoute(handle, options)
        return {
            ...(route !== undefined ? { route } : {}),
            ...(options?.signal ? { signal: options.signal } : {})
        }
    }

    private isLocalSource = (source: 'local' | 'remote'): boolean => {
        return source === 'local'
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

    private resolveGetAllMergePolicy = <T extends Entity>(handle: StoreHandle<T>): GetAllMergePolicy => {
        const policy = handle.config.getAllMergePolicy
        if (policy === 'replace' || policy === 'upsert-only' || policy === 'preserve-missing') {
            return policy
        }
        return 'replace'
    }

    query = async <T extends Entity>(
        handle: StoreHandle<T>,
        input: StoreQuery<T>,
        options?: StoreReadOptions
    ): Promise<QueryResult<T>> => {
        const runtime = this.runtime
        const events = runtime.events

        events.emit.readStart({ handle, query: input })

        try {
            const startedAt = runtime.now()
            const output = await runtime.execution.query(
                {
                    handle,
                    query: input
                },
                this.toExecutionOptions(handle, options)
            )
            const durationMs = runtime.now() - startedAt

            const fetched = Array.isArray(output.data) ? output.data : []
            if (this.isLocalSource(output.source)) {
                const result = this.toQueryResult(fetched as T[], output.pageInfo)
                events.emit.readFinish({ handle, query: input, result, durationMs })
                return result
            }

            const remote = await this.writebackArray(handle, fetched)

            const cachePolicy = queryStorePolicy(input)
            if (cachePolicy.skipStore) {
                const result = this.toQueryResult(remote, output.pageInfo)
                events.emit.readFinish({ handle, query: input, result, durationMs })
                return result
            }

            const processed = this.applyQueryWriteback(handle, remote)
            const result = this.toQueryResult(processed, output.pageInfo)
            events.emit.readFinish({ handle, query: input, result, durationMs })
            return result
        } catch (error) {
            throw toError(error, '[Atoma] query failed')
        }
    }

    queryOne = async <T extends Entity>(
        handle: StoreHandle<T>,
        input: StoreQuery<T>,
        options?: StoreReadOptions
    ): Promise<QueryOneResult<T>> => {
        const next: StoreQuery<T> = {
            ...input,
            page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
        }
        const result = await this.query(handle, next, options)
        return { data: result.data[0] }
    }

    getMany = async <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], cache = true): Promise<T[]> => {
        const beforeMap = handle.state.getSnapshot() as Map<EntityId, T>
        const resolvedItems: Array<T | undefined> = new Array(ids.length)
        const missingSet = new Set<EntityId>()
        const missingUnique: EntityId[] = []

        for (let index = 0; index < ids.length; index++) {
            const id = ids[index]
            const cached = beforeMap.get(id)
            if (cached !== undefined) {
                resolvedItems[index] = cached
                continue
            }
            resolvedItems[index] = undefined
            if (!missingSet.has(id)) {
                missingSet.add(id)
                missingUnique.push(id)
            }
        }

        if (missingUnique.length) {
            const queryOutput = await this.runtime.execution.query(
                {
                    handle,
                    query: {
                        filter: { op: 'in', field: 'id', values: missingUnique }
                    }
                },
                {
                    route: this.resolveQueryRoute(handle)
                }
            )

            const before = handle.state.getSnapshot() as Map<EntityId, T>
            const fetchedById = new Map<EntityId, T>()
            const itemsToCache: T[] = []

            if (this.isLocalSource(queryOutput.source)) {
                for (const item of (Array.isArray(queryOutput.data) ? queryOutput.data : []) as T[]) {
                    fetchedById.set(item.id, item)
                }
            } else {
                for (const rawItem of queryOutput.data) {
                    if (rawItem === undefined) continue
                    const processed = await this.writebackOne(handle, rawItem)
                    if (!processed) continue

                    const id = processed.id
                    const existing = before.get(id)
                    const preserved = this.runtime.engine.mutation.preserveRef(existing, processed)

                    fetchedById.set(id, preserved)
                    if (cache) itemsToCache.push(preserved)
                }
            }

            if (cache && itemsToCache.length) {
                const after = this.runtime.engine.mutation.addMany(itemsToCache, before)
                if (after !== before) {
                    handle.state.commit({ before, after })
                }
            }

            for (let index = 0; index < ids.length; index++) {
                if (resolvedItems[index] !== undefined) continue
                const id = ids[index]
                resolvedItems[index] = fetchedById.get(id)
            }
        }

        return resolvedItems.filter((item): item is T => item !== undefined)
    }

    getOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId): Promise<T | undefined> => {
        const cached = handle.state.getSnapshot().get(id)
        if (cached !== undefined) return cached
        const items = await this.getMany(handle, [id], true)
        return items[0]
    }

    fetchOne = async <T extends Entity>(
        handle: StoreHandle<T>,
        id: EntityId,
        options?: StoreReadOptions
    ): Promise<T | undefined> => {
        const output = await this.runtime.execution.query(
            {
                handle,
                query: {
                    filter: { op: 'eq', field: 'id', value: id },
                    page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
                }
            },
            this.toExecutionOptions(handle, options)
        )
        const one = output.data[0]
        if (one === undefined) return undefined
        if (this.isLocalSource(output.source)) {
            return one as T
        }
        return await this.writebackOne(handle, one)
    }

    fetchAll = async <T extends Entity>(handle: StoreHandle<T>, options?: StoreReadOptions): Promise<T[]> => {
        const output = await this.runtime.execution.query(
            {
                handle,
                query: {}
            },
            this.toExecutionOptions(handle, options)
        )
        if (this.isLocalSource(output.source)) {
            return Array.isArray(output.data) ? (output.data as T[]) : []
        }
        return await this.writebackArray(handle, output.data)
    }

    getAll = async <T extends Entity>(
        handle: StoreHandle<T>,
        filter?: (item: T) => boolean,
        cacheFilter?: (item: T) => boolean
    ): Promise<T[]> => {
        const existingMap = handle.state.getSnapshot() as Map<EntityId, T>
        const mergePolicy = this.resolveGetAllMergePolicy(handle)
        const output = await this.runtime.execution.query(
            {
                handle,
                query: {}
            },
            {
                route: this.resolveQueryRoute(handle)
            }
        )
        const fetched = Array.isArray(output.data) ? output.data : []
        if (this.isLocalSource(output.source)) {
            const localOutput = fetched as T[]
            if (!filter) return localOutput
            return localOutput.filter(item => filter(item))
        }
        const resultItems: T[] = []
        const nonCachedOutput: T[] = []
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
                resultItems.push(processed)
                nonCachedOutput.push(processed)
                continue
            }

            const existing = existingMap.get(id)
            const preserved = this.runtime.engine.mutation.preserveRef(existing, processed)
            itemsToCache.push(preserved)
            resultItems.push(preserved)
        }

        let next = existingMap
        if (mergePolicy === 'replace') {
            const toRemove: EntityId[] = []
            existingMap.forEach((_value, id) => {
                if (!incomingIds.has(id)) toRemove.push(id)
            })
            next = this.runtime.engine.mutation.removeMany(toRemove, existingMap)
        }

        if (itemsToCache.length) {
            next = this.runtime.engine.mutation.addMany(itemsToCache, next)
        }

        if (next !== existingMap) {
            handle.state.commit({ before: existingMap, after: next })
        }

        if (mergePolicy === 'preserve-missing') {
            const mergedById = new Map<EntityId, T>()
            next.forEach((item, id) => {
                if (filter && !filter(item)) return
                mergedById.set(id, item)
            })
            for (const item of nonCachedOutput) {
                mergedById.set(item.id, item)
            }
            return Array.from(mergedById.values())
        }

        return resultItems
    }
}

const queryStorePolicy = <T extends Entity>(query?: StoreQuery<T>) => {
    const hasSelect = Boolean(Array.isArray(query?.select) && query.select.length)
    if (hasSelect) {
        return { skipStore: true, reason: 'select' }
    }

    const include = query?.include
    const hasInclude = Boolean(include && typeof include === 'object' && Object.keys(include).length)
    if (hasInclude) {
        return { skipStore: true, reason: 'include' }
    }

    return { skipStore: false }
}
