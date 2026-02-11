import type {
    Entity,
    Query,
    QueryOneResult,
    QueryResult,
} from '../core'
import type { EntityId } from '../shared'
import type { StoreHandle } from './handle'

export type Read = Readonly<{
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>) => Promise<QueryResult<T>>
    queryOne: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>) => Promise<QueryOneResult<T>>
    getMany: <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], cache?: boolean) => Promise<T[]>
    getOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId) => Promise<T | undefined>
    fetchOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId) => Promise<T | undefined>
    fetchAll: <T extends Entity>(handle: StoreHandle<T>) => Promise<T[]>
    getAll: <T extends Entity>(
        handle: StoreHandle<T>,
        filter?: (item: T) => boolean,
        cacheFilter?: (item: T) => boolean
    ) => Promise<T[]>
}>
