import type { EntityId } from '../shared'
import type { PartialWithId } from './entity'
import type { ActionContext } from './action'
import type { StoreDataProcessor } from './processor'
import type { Query, QueryOneResult, QueryResult } from './query'

export type UpsertConflict = 'cas' | 'lww'
export type UpsertApply = 'merge' | 'replace'

export type UpsertWriteOptions = {
    conflict?: UpsertConflict
    apply?: UpsertApply
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

export interface StoreOperationOptions {
    force?: boolean
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
    write?: Readonly<{
        route?: ExecutionRoute
    }>
}

export type StoreToken = string

export type ExecutionRoute = string

declare const RELATIONS_BRAND: unique symbol

export interface Store<T, Relations = {}> {
    readonly [RELATIONS_BRAND]?: Relations

    create(item: Partial<T>, options?: StoreOperationOptions): Promise<T>
    createMany(items: Array<Partial<T>>, options?: StoreOperationOptions): Promise<WriteManyResult<T>>
    update(id: EntityId, updater: StoreUpdater<T>, options?: StoreOperationOptions): Promise<T>
    updateMany(
        items: Array<{ id: EntityId; updater: StoreUpdater<T> }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>>
    delete(id: EntityId, options?: StoreOperationOptions): Promise<void>
    deleteMany(ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<void>>
    upsert(item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T>
    upsertMany(items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>>
    get(id: EntityId, options?: StoreReadOptions): Promise<T | undefined>
    getMany(ids: EntityId[], options?: StoreReadOptions): Promise<T[]>
    list(options?: StoreReadOptions): Promise<T[]>
    query(query: Query<T>, options?: StoreReadOptions): Promise<QueryResult<T>>
    queryOne(query: Query<T>, options?: StoreReadOptions): Promise<QueryOneResult<T>>
}
