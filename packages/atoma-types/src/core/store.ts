import type { Draft } from 'immer'
import type { EntityId } from '../shared'
import type { Entity, PartialWithId } from './entity'
import type { OperationContext } from './operation'
import type { StoreDataProcessor } from './processor'
import type { Query, QueryOneResult, QueryResult } from './query'

export type UpsertMode = 'strict' | 'loose'

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

export type DeleteItem = {
    id: EntityId
    baseVersion: number
}

export type WriteIntentOptions = {
    merge?: boolean
    upsert?: {
        mode?: 'strict' | 'loose'
    }
}

export type WriteIntent<T = unknown> = Readonly<{
    action: 'create' | 'update' | 'upsert' | 'delete'
    entityId?: EntityId
    value?: T
    baseVersion?: number
    options?: WriteIntentOptions
    intent?: 'created'
}>

export interface StoreOperationOptions {
    force?: boolean
    batch?: {
        concurrency?: number
    }
    writeStrategy?: WriteStrategy
    opContext?: OperationContext
}

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

export interface LifecycleHooks<T> {
    beforeSave?: (args: { action: 'add' | 'update'; item: PartialWithId<T> }) => PartialWithId<T> | Promise<PartialWithId<T>>
    afterSave?: (args: { action: 'add' | 'update'; item: PartialWithId<T> }) => void | Promise<void>
}

export interface StoreConfig<T> {
    idGenerator?: () => EntityId
    dataProcessor?: StoreDataProcessor<T>
    hooks?: LifecycleHooks<T>
    indexes?: Array<IndexDefinition<T>>
    storeName?: string
    write?: Readonly<{
        strategy?: WriteStrategy
    }>
}

export type StoreToken = string

export type WriteStrategy = string

declare const RELATIONS_BRAND: unique symbol

export interface Store<T, Relations = {}> {
    readonly [RELATIONS_BRAND]?: Relations

    addOne(item: Partial<T>, options?: StoreOperationOptions): Promise<T>
    addMany(items: Array<Partial<T>>, options?: StoreOperationOptions): Promise<T[]>
    updateOne(id: EntityId, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions): Promise<T>
    updateMany(
        items: Array<{ id: EntityId; recipe: (draft: Draft<T>) => void }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>>
    deleteOne(id: EntityId, options?: StoreOperationOptions): Promise<boolean>
    deleteMany(ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>>
    upsertOne(item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T>
    upsertMany(items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>>
    getOne(id: EntityId): Promise<T | undefined>
    fetchOne(id: EntityId): Promise<T | undefined>
    getAll(filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean): Promise<T[]>
    fetchAll?(): Promise<T[]>
    getMany(ids: EntityId[], cache?: boolean): Promise<T[]>
    query?(query: Query<T>): Promise<QueryResult<T>>
    queryOne?(query: Query<T>): Promise<QueryOneResult<T>>
}
