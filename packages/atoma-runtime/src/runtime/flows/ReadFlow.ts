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

    private toQueryResult = <T extends Entity>(data: T[], pageInfo?: QueryResult<T>['pageInfo']): QueryResult<T> => {
        return pageInfo ? { data, pageInfo } : { data }
    }

    private trackRead = async <T extends Entity>({ handle, query, run }: {
        handle: StoreHandle<T>
        query: StoreQuery<T>
        run: () => Promise<QueryResult<T>>
    }): Promise<QueryResult<T>> => {
        const startedAt = this.runtime.now()
        this.runtime.events.emit.readStart({
            handle,
            query
        })
        const result = await run()
        this.runtime.events.emit.readFinish({
            handle,
            query,
            result,
            durationMs: this.runtime.now() - startedAt
        })
        return result
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
        const output: T[] = []
        handle.state.mutate((draft) => {
            remote.forEach((item) => {
                const existing = draft.get(item.id)
                const preserved = this.runtime.engine.mutation.preserveRef(existing, item)
                output.push(preserved)
                if (draft.has(item.id) && existing === preserved) return
                draft.set(item.id, preserved)
            })
        })
        return output
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
        try {
            return await this.trackRead({
                handle,
                query: input,
                run: async () => {
                    const output = await this.runtime.execution.query(
                        {
                            handle,
                            query: input
                        },
                        this.toExecutionOptions(handle, options)
                    )

                    const fetched = Array.isArray(output.data) ? output.data : []
                    if (this.isLocalSource(output.source)) {
                        return this.toQueryResult(fetched as T[], output.pageInfo)
                    }

                    const remote = await this.writebackArray(handle, fetched)

                    const cachePolicy = queryStorePolicy(input)
                    if (cachePolicy.skipStore) {
                        return this.toQueryResult(remote, output.pageInfo)
                    }

                    const processed = this.applyQueryWriteback(handle, remote)
                    return this.toQueryResult(processed, output.pageInfo)
                }
            })
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
        const readQuery: StoreQuery<T> = {
            filter: { op: 'in', field: 'id', values: ids }
        }
        const result = await this.trackRead({
            handle,
            query: readQuery,
            run: async () => {
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
                        handle.state.mutate((draft) => {
                            itemsToCache.forEach((item) => {
                                if (draft.has(item.id) && draft.get(item.id) === item) return
                                draft.set(item.id, item)
                            })
                        })
                    }

                    for (let index = 0; index < ids.length; index++) {
                        if (resolvedItems[index] !== undefined) continue
                        const id = ids[index]
                        resolvedItems[index] = fetchedById.get(id)
                    }
                }

                return this.toQueryResult(
                    resolvedItems.filter((item): item is T => item !== undefined)
                )
            }
        })

        return result.data
    }

    getOne = async <T extends Entity>(handle: StoreHandle<T>, id: EntityId): Promise<T | undefined> => {
        const items = await this.getMany(handle, [id], true)
        return items[0]
    }

    fetchOne = async <T extends Entity>(
        handle: StoreHandle<T>,
        id: EntityId,
        options?: StoreReadOptions
    ): Promise<T | undefined> => {
        const query: StoreQuery<T> = {
            filter: { op: 'eq', field: 'id', value: id },
            page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
        }
        const result = await this.trackRead({
            handle,
            query,
            run: async () => {
                const output = await this.runtime.execution.query(
                    {
                        handle,
                        query
                    },
                    this.toExecutionOptions(handle, options)
                )
                const one = output.data[0]
                if (one === undefined) return this.toQueryResult([])
                if (this.isLocalSource(output.source)) {
                    return this.toQueryResult([one as T], output.pageInfo)
                }
                const remote = await this.writebackOne(handle, one)
                return this.toQueryResult(remote ? [remote] : [], output.pageInfo)
            }
        })
        return result.data[0]
    }

    fetchAll = async <T extends Entity>(handle: StoreHandle<T>, options?: StoreReadOptions): Promise<T[]> => {
        const result = await this.trackRead({
            handle,
            query: {},
            run: async () => {
                const output = await this.runtime.execution.query(
                    {
                        handle,
                        query: {}
                    },
                    this.toExecutionOptions(handle, options)
                )
                if (this.isLocalSource(output.source)) {
                    return this.toQueryResult(Array.isArray(output.data) ? (output.data as T[]) : [], output.pageInfo)
                }
                return this.toQueryResult(await this.writebackArray(handle, output.data), output.pageInfo)
            }
        })
        return result.data
    }

    getAll = async <T extends Entity>(
        handle: StoreHandle<T>,
        filter?: (item: T) => boolean,
        cacheFilter?: (item: T) => boolean
    ): Promise<T[]> => {
        const result = await this.trackRead({
            handle,
            query: {},
            run: async () => {
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
                    return this.toQueryResult(filter ? localOutput.filter(item => filter(item)) : localOutput, output.pageInfo)
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
                    if (toRemove.length || itemsToCache.length) {
                        handle.state.mutate((draft) => {
                            toRemove.forEach((id) => {
                                draft.delete(id)
                            })
                            itemsToCache.forEach((item) => {
                                if (draft.has(item.id) && draft.get(item.id) === item) return
                                draft.set(item.id, item)
                            })
                        })
                        next = handle.state.getSnapshot() as Map<EntityId, T>
                    }
                } else if (itemsToCache.length) {
                    handle.state.mutate((draft) => {
                        itemsToCache.forEach((item) => {
                            if (draft.has(item.id) && draft.get(item.id) === item) return
                            draft.set(item.id, item)
                        })
                    })
                    next = handle.state.getSnapshot() as Map<EntityId, T>
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
                    return this.toQueryResult(Array.from(mergedById.values()), output.pageInfo)
                }

                return this.toQueryResult(resultItems, output.pageInfo)
            }
        })
        return result.data
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
