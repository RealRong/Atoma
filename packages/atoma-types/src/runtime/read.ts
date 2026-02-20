import type {
    Entity,
    Query,
    QueryOneResult,
    QueryResult,
    StoreReadOptions
} from '../core'
import type { EntityId } from '../shared'
import type { StoreHandle } from './store/handle'

export type Read = Readonly<{
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>, options?: StoreReadOptions) => Promise<QueryResult<T>>
    queryOne: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>, options?: StoreReadOptions) => Promise<QueryOneResult<T>>
    get: <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreReadOptions) => Promise<T | undefined>
    getMany: <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreReadOptions) => Promise<T[]>
    list: <T extends Entity>(
        handle: StoreHandle<T>,
        options?: StoreReadOptions
    ) => Promise<T[]>
}>
