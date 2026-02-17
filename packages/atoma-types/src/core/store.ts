import type { EntityId } from '../shared'
import type { Entity, PartialWithId } from './entity'
import type { ActionContext } from './action'
import type { StoreDataProcessor } from './processor'
import type { Query, QueryOneResult, QueryResult } from './query'

export type UpsertMode = 'strict' | 'loose'
export type GetAllMergePolicy = 'replace' | 'upsert-only' | 'preserve-missing'

export type UpsertWriteOptions = {
    mode?: UpsertMode
    merge?: boolean
}

export type WriteManyItemOk<T> = {
    index: number
    ok: true
    value: T
}

export type WriteManyItemErr = {
    index: number
    ok: false
    error: unknown
    current?: {
        value?: unknown
        version?: number
    }
}

export type WriteManyResult<T> = Array<WriteManyItemOk<T> | WriteManyItemErr>

export type StoreUpdater<T> = (current: Readonly<T>) => T

export type DeleteItem = {
    id: EntityId
    baseVersion: number
}

export interface StoreOperationOptions {
    force?: boolean
    batch?: {
        concurrency?: number
    }
    route?: ExecutionRoute
    signal?: AbortSignal
    context?: Partial<ActionContext>
}

export type StoreReadOptions = Readonly<{
    route?: ExecutionRoute
    signal?: AbortSignal
}>

export type IndexType = 'number' | 'date' | 'string' | 'substring' | 'text'

export interface IndexDefinition<T> {
    field: keyof T & string
    type: IndexType
    options?: {
        minTokenLength?: number
        fuzzyDistance?: 0 | 1 | 2
        tokenizer?: (text: string) => string[]
        ngramSize?: number
    }
}

export interface StoreConfig<T> {
    idGenerator?: () => EntityId
    dataProcessor?: StoreDataProcessor<T>
    indexes?: Array<IndexDefinition<T>>
    storeName?: StoreToken
    read?: Readonly<{
        getAllMergePolicy?: GetAllMergePolicy
    }>
    write?: Readonly<{
        route?: ExecutionRoute
    }>
}

export type StoreToken = string

export type ExecutionRoute = string

declare const RELATIONS_BRAND: unique symbol

export interface Store<T, Relations = {}> {
    readonly [RELATIONS_BRAND]?: Relations

    addOne(item: Partial<T>, options?: StoreOperationOptions): Promise<T>
    addMany(items: Array<Partial<T>>, options?: StoreOperationOptions): Promise<T[]>
    updateOne(id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T>
    updateMany(
        items: Array<{ id: EntityId; updater: StoreUpdater<T> }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>>
    deleteOne(id: EntityId, options?: StoreOperationOptions): Promise<boolean>
    deleteMany(ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>>
    upsertOne(item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T>
    upsertMany(items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>>
    getOne(id: EntityId): Promise<T | undefined>
    fetchOne(id: EntityId, options?: StoreReadOptions): Promise<T | undefined>
    getAll(filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean): Promise<T[]>
    fetchAll?(options?: StoreReadOptions): Promise<T[]>
    getMany(ids: EntityId[], cache?: boolean): Promise<T[]>
    query?(query: Query<T>, options?: StoreReadOptions): Promise<QueryResult<T>>
    queryOne?(query: Query<T>, options?: StoreReadOptions): Promise<QueryOneResult<T>>
}
