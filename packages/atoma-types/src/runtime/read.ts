import type {
    Entity,
    Query,
    QueryOneResult,
    QueryResult,
    StoreReadOptions
} from '../core'
import type { EntityId } from '../shared'
import type { StoreHandle } from './handle'

export type Read = Readonly<{
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>, options?: StoreReadOptions) => Promise<QueryResult<T>>
    queryOne: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>, options?: StoreReadOptions) => Promise<QueryOneResult<T>>
    getMany: <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], cache?: boolean) => Promise<T[]>
    getOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId) => Promise<T | undefined>
    fetchOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreReadOptions) => Promise<T | undefined>
    fetchAll: <T extends Entity>(handle: StoreHandle<T>, options?: StoreReadOptions) => Promise<T[]>
    getAll: <T extends Entity>(
        handle: StoreHandle<T>,
        filter?: (item: T) => boolean,
        cacheFilter?: (item: T) => boolean
    ) => Promise<T[]>
}>
