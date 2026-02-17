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
import type { ExecutionQueryOutput, Runtime, Read, StoreHandle } from 'atoma-types/runtime'

const shouldSkipStore = <T extends Entity>(query?: StoreQuery<T>): boolean => {
    if (Array.isArray(query?.select) && query.select.length > 0) {
        return true
    }

    const include = query?.include
    return Boolean(include && typeof include === 'object' && Object.keys(include).length > 0)
}

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

    private resolveQueryRoute = <T extends Entity>(handle: StoreHandle<T>, options?: StoreReadOptions) => {
        return options?.route ?? handle.config.defaultRoute
    }

    private toExecutionOptions = <T extends Entity>(handle: StoreHandle<T>, options?: StoreReadOptions) => {
        const route = this.resolveQueryRoute(handle, options)
        return {
            ...(route !== undefined ? { route } : {}),
            ...(options?.signal ? { signal: options.signal } : {})
        }
    }

    private executeQuery = async <T extends Entity>(args: {
        handle: StoreHandle<T>
        query: StoreQuery<T>
        options?: StoreReadOptions
    }): Promise<ExecutionQueryOutput<T>> => {
        return await this.runtime.execution.query(
            {
                handle: args.handle,
                query: args.query
            },
            this.toExecutionOptions(args.handle, args.options)
        )
    }

    private getOutputData = <T extends Entity>(output: ExecutionQueryOutput<T>): unknown[] => {
        return Array.isArray(output.data) ? output.data : []
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

    private cacheItems = <T extends Entity>(handle: StoreHandle<T>, items: T[]) => {
        if (!items.length) return

        handle.state.mutate((draft) => {
            items.forEach((item) => {
                if (draft.has(item.id) && draft.get(item.id) === item) return
                draft.set(item.id, item)
            })
        })
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
                    const output = await this.executeQuery({
                        handle,
                        query: input,
                        options
                    })

                    if (output.source === 'local') {
                        return this.toQueryResult(this.getOutputData(output) as T[], output.pageInfo)
                    }

                    const remote = await this.writebackArray(handle, this.getOutputData(output))
                    return shouldSkipStore(input)
                        ? this.toQueryResult(remote, output.pageInfo)
                        : this.toQueryResult(this.applyQueryWriteback(handle, remote), output.pageInfo)
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
                const missingUnique: EntityId[] = []
                const missingSet = new Set<EntityId>()

                for (let index = 0; index < ids.length; index++) {
                    const id = ids[index]
                    const cached = beforeMap.get(id)
                    if (cached !== undefined) {
                        resolvedItems[index] = cached
                        continue
                    }
                    resolvedItems[index] = undefined
                    if (missingSet.has(id)) continue
                    missingSet.add(id)
                    missingUnique.push(id)
                }

                if (missingUnique.length) {
                    const output = await this.executeQuery({
                        handle,
                        query: {
                            filter: { op: 'in', field: 'id', values: missingUnique }
                        }
                    })

                    const fetchedById = new Map<EntityId, T>()
                    if (output.source === 'local') {
                        ;(this.getOutputData(output) as T[]).forEach((item) => {
                            fetchedById.set(item.id, item)
                        })
                    } else {
                        const before = handle.state.getSnapshot() as Map<EntityId, T>
                        const remote = await this.writebackArray(handle, this.getOutputData(output))
                        const itemsToCache: T[] = []

                        remote.forEach((item) => {
                            const preserved = this.runtime.engine.mutation.preserveRef(before.get(item.id), item)
                            fetchedById.set(item.id, preserved)
                            if (cache) itemsToCache.push(preserved)
                        })

                        if (cache) {
                            this.cacheItems(handle, itemsToCache)
                        }
                    }

                    for (let index = 0; index < ids.length; index++) {
                        if (resolvedItems[index] !== undefined) continue
                        resolvedItems[index] = fetchedById.get(ids[index])
                    }
                }

                return this.toQueryResult(resolvedItems.filter((item): item is T => item !== undefined))
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
                const output = await this.executeQuery({
                    handle,
                    query,
                    options
                })
                const one = this.getOutputData(output)[0]
                if (one === undefined) return this.toQueryResult([], output.pageInfo)

                if (output.source === 'local') {
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
                const output = await this.executeQuery({
                    handle,
                    query: {},
                    options
                })
                if (output.source === 'local') {
                    return this.toQueryResult(this.getOutputData(output) as T[], output.pageInfo)
                }
                return this.toQueryResult(await this.writebackArray(handle, this.getOutputData(output)), output.pageInfo)
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
                const output = await this.executeQuery({
                    handle,
                    query: {}
                })

                if (output.source === 'local') {
                    const local = this.getOutputData(output) as T[]
                    return this.toQueryResult(filter ? local.filter((item) => filter(item)) : local, output.pageInfo)
                }

                const remote = await this.writebackArray(handle, this.getOutputData(output))
                const incomingIds = new Set<EntityId>()
                const resultItems: T[] = []
                const nonCachedOutput: T[] = []
                const itemsToCache: T[] = []

                remote.forEach((item) => {
                    if (filter && !filter(item)) return

                    incomingIds.add(item.id)
                    const shouldCacheItem = cacheFilter ? cacheFilter(item) : true
                    if (!shouldCacheItem) {
                        resultItems.push(item)
                        nonCachedOutput.push(item)
                        return
                    }

                    const preserved = this.runtime.engine.mutation.preserveRef(existingMap.get(item.id), item)
                    itemsToCache.push(preserved)
                    resultItems.push(preserved)
                })

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
                    this.cacheItems(handle, itemsToCache)
                    next = handle.state.getSnapshot() as Map<EntityId, T>
                }

                if (mergePolicy === 'preserve-missing') {
                    const mergedById = new Map<EntityId, T>()
                    next.forEach((item, id) => {
                        if (filter && !filter(item)) return
                        mergedById.set(id, item)
                    })
                    nonCachedOutput.forEach((item) => {
                        mergedById.set(item.id, item)
                    })
                    return this.toQueryResult(Array.from(mergedById.values()), output.pageInfo)
                }

                return this.toQueryResult(resultItems, output.pageInfo)
            }
        })
        return result.data
    }
}
