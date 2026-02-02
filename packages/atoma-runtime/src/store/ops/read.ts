import type { Entity, Query, QueryOneResult, QueryResult, StoreReadOptions } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { CoreRuntime, StoreHandle } from '../../types/runtimeTypes'

export function createQuery<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (query: Query<T>): Promise<QueryResult<T>> => {
        return await clientRuntime.read.query(handle, query)
    }
}

export function createQueryOne<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (input: Query<T>): Promise<QueryOneResult<T>> => {
        return await clientRuntime.read.queryOne(handle, input)
    }
}

export function createGetMany<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (ids: EntityId[], cache = true, options?: StoreReadOptions) => {
        return await clientRuntime.read.getMany(handle, ids, cache, options)
    }
}

export function createGetAll<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async (filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: StoreReadOptions) => {
        return await clientRuntime.read.getAll(handle, filter, cacheFilter, options)
    }
}

export function createFetchAll<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async () => {
        return await clientRuntime.read.fetchAll(handle)
    }
}

export function createBatchGet<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return {
        getOne: (id: EntityId, options?: StoreReadOptions) => {
            return clientRuntime.read.getOne(handle, id, options)
        },
        fetchOne: (id: EntityId, options?: StoreReadOptions) => {
            return clientRuntime.read.fetchOne(handle, id, options)
        }
    }
}
