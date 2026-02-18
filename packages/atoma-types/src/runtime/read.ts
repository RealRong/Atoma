import type {
    Entity,
    Query,
    QueryOneResult,
    QueryResult,
    StoreGetManyOptions,
    StoreGetOptions,
    StoreListOptions,
    StoreReadOptions
} from '../core'
import type { EntityId } from '../shared'
import type { StoreHandle } from './handle'

export type Read = Readonly<{
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>, options?: StoreReadOptions) => Promise<QueryResult<T>>
    queryOne: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>, options?: StoreReadOptions) => Promise<QueryOneResult<T>>
    get: <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreGetOptions) => Promise<T | undefined>
    getMany: <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreGetManyOptions) => Promise<T[]>
    list: <T extends Entity>(
        handle: StoreHandle<T>,
        options?: StoreListOptions<T>
    ) => Promise<T[]>
}>
