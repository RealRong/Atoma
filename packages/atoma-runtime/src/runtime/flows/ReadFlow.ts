import type {
    Entity,
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

    private executeQuery = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: StoreQuery<T>,
        options?: StoreReadOptions
    ): Promise<ExecutionQueryOutput<T>> => {
        return await this.runtime.execution.query(
            {
                handle,
                query
            },
            options
        )
    }

    private getOutputData = <T extends Entity>(output: ExecutionQueryOutput<T>): unknown[] => {
        return Array.isArray(output.data) ? output.data : []
    }

    private writebackArray = async <T extends Entity>(handle: StoreHandle<T>, input: unknown[]): Promise<T[]> => {
        const output: T[] = []
        for (const item of input) {
            const processed = await this.runtime.transform.writeback(handle, item as T)
            if (processed !== undefined) output.push(processed)
        }
        return output
    }

    private applyStoreWriteback = <T extends Entity>(args: {
        handle: StoreHandle<T>
        upserts?: T[]
        deletes?: EntityId[]
    }): ReadonlyMap<EntityId, T> => {
        const upserts = args.upserts ?? []
        const deletes = args.deletes ?? []
        if (!upserts.length && !deletes.length) {
            return args.handle.state.getSnapshot() as ReadonlyMap<EntityId, T>
        }

        args.handle.state.applyWriteback({
            ...(upserts.length ? { upserts } : {}),
            ...(deletes.length ? { deletes } : {})
        })
        return args.handle.state.getSnapshot() as ReadonlyMap<EntityId, T>
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
                    const output = await this.executeQuery(handle, input, options)

                    if (output.source === 'local') {
                        return this.toQueryResult(this.getOutputData(output) as T[], output.pageInfo)
                    }

                    const remote = await this.writebackArray(handle, this.getOutputData(output))
                    const skipStore = shouldSkipStore(input)
                    const snapshot = skipStore
                        ? undefined
                        : this.applyStoreWriteback({
                            handle,
                            upserts: remote
                        })
                    return skipStore
                        ? this.toQueryResult(remote, output.pageInfo)
                        : this.toQueryResult(
                            remote.map((item) => snapshot?.get(item.id) ?? item),
                            output.pageInfo
                        )
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

    list = async <T extends Entity>(handle: StoreHandle<T>, options?: StoreReadOptions): Promise<T[]> => {
        const result = await this.trackRead({
            handle,
            query: {},
            run: async () => {
                const existingMap = handle.state.getSnapshot() as Map<EntityId, T>
                const output = await this.executeQuery(handle, {}, options)

                if (output.source === 'local') {
                    return this.toQueryResult(this.getOutputData(output) as T[], output.pageInfo)
                }

                const remote = await this.writebackArray(handle, this.getOutputData(output))
                const incomingIds = new Set<EntityId>()

                remote.forEach((item) => {
                    incomingIds.add(item.id)
                })

                const toRemove: EntityId[] = []
                existingMap.forEach((_value, id) => {
                    if (!incomingIds.has(id)) toRemove.push(id)
                })

                const snapshot = this.applyStoreWriteback({
                    handle,
                    upserts: remote,
                    deletes: toRemove
                })

                return this.toQueryResult(
                    remote.map((item) => snapshot.get(item.id) ?? item),
                    output.pageInfo
                )
            }
        })
        return result.data
    }

    get = async <T extends Entity>(
        handle: StoreHandle<T>,
        id: EntityId,
        options?: StoreReadOptions
    ): Promise<T | undefined> => {
        const items = await this.getMany(handle, [id], options)
        return items[0]
    }

    getMany = async <T extends Entity>(
        handle: StoreHandle<T>,
        ids: EntityId[],
        options?: StoreReadOptions
    ): Promise<T[]> => {
        if (!ids.length) return []
        const queryIds = ids.length > 1 ? [...new Set(ids)] : ids

        const query: StoreQuery<T> = {
            filter: { op: 'in', field: 'id', values: queryIds }
        }
        const result = await this.trackRead({
            handle,
            query,
            run: async () => {
                const output = await this.executeQuery(handle, query, options)

                const resolvedById = new Map<EntityId, T>()
                if (output.source === 'local') {
                    ;(this.getOutputData(output) as T[]).forEach((item) => {
                        resolvedById.set(item.id, item)
                    })
                } else {
                    const remote = await this.writebackArray(handle, this.getOutputData(output))
                    const snapshot = this.applyStoreWriteback({
                        handle,
                        upserts: remote
                    })
                    remote.forEach((item) => {
                        resolvedById.set(item.id, snapshot.get(item.id) ?? item)
                    })
                }

                return this.toQueryResult(
                    ids
                        .map((id) => resolvedById.get(id))
                        .filter((item): item is T => item !== undefined)
                )
            }
        })

        return result.data
    }

}
