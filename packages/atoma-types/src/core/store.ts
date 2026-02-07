import type { Draft } from 'immer'
import type { EntityId } from '../protocol'
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

export type WriteIntent<T = any> = Readonly<{
    action: 'create' | 'update' | 'upsert' | 'delete'
    entityId?: EntityId
    value?: T
    baseVersion?: number
    options?: WriteIntentOptions
    intent?: 'created'
}>

/**
 * 写入确认语义（只影响 `await store.addOne/updateOne/delete...` 何时完成）
 * - optimistic：等待 enqueued（持久化层已接管：例如已提交、已入队、已持久化到本地等）
 * - strict：等待 confirmed（持久化层已确认：例如远端返回最终结果/版本）
 */
export type WriteConfirmation = 'optimistic' | 'strict'

export type WriteTimeoutBehavior = 'reject' | 'resolve-enqueued'

/**
 * Options for store operations
 */
export interface StoreOperationOptions {
    force?: boolean
    /**
     * 批量操作执行配置（addMany/updateMany/upsertMany/deleteMany）
     * - 默认 `{ concurrency: 1 }`（串行）
     * - `concurrency > 1` 时启用受控并发
     */
    batch?: {
        /** 并发度，<=1 视为串行 */
        concurrency?: number
    }
    /**
     * 写入策略（本次调用级别）。不指定时使用该 store 的 schema 默认策略（若也未配置，则视为 direct）。
     *
     * 说明：
     * - 这是“写入执行参数”，不属于 store identity。
     * - 由 core 透传给 `CoreRuntime.persistence.persist`，并由 persistence handlers 决定语义。
     */
    writeStrategy?: WriteStrategy
    /**
     * `await` 完成语义（默认 optimistic）
     * - 注意：不影响 UI 是否立即更新（UI 仍默认 optimistic commit）
     */
    confirmation?: WriteConfirmation
    /** strict 等待 confirmed 的超时（可选）。undefined 表示无限等待 */
    timeoutMs?: number
    /** strict 超时策略（默认 reject） */
    timeoutBehavior?: WriteTimeoutBehavior
    /**
     * 操作上下文（上层语义：scope/origin/actionId）
     * - 若未提供，core 会在 dispatch 阶段补齐默认值（scope='default', origin='user'）
     */
    opContext?: OperationContext
}

/**
 * Options for read operations (public, pure-data)
 */
export interface StoreReadOptions {
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

/**
 * Store configuration options
 */
export interface StoreConfig<T> {
    /** Custom ID generator (defaults to Snowflake-like generator) */
    idGenerator?: () => EntityId

    /** Data processor pipeline (deserialize/normalize/transform/validate/sanitize/serialize) */
    dataProcessor?: StoreDataProcessor<T>

    /** Lifecycle hooks for add/update */
    hooks?: LifecycleHooks<T>

    /** Optional index definitions (for query 优先命中) */
    indexes?: Array<IndexDefinition<T>>

    /** Store name（用于 devtools 标识） */
    storeName?: string

    /**
     * Default write behavior for this store.
     * - `strategy` is opaque to core (plugins interpret it).
     */
    write?: Readonly<{
        strategy?: WriteStrategy
    }>
}

/**
 * Store token - currently a string (store name)
 */
export type StoreToken = string

/**
 * Write strategy (opaque to core).
 * - 用于 store view / 上层 wiring 选择不同的写入策略实现（例如 direct / queue / local-first）
 */
export type WriteStrategy = string

declare const RELATIONS_BRAND: unique symbol

/**
 * Store interface - main API for CRUD operations
 */
export interface IStore<T, Relations = {}> {
    /**
     * 类型占位（运行时不要求存在）：
     * - 用于在泛型推导时把 Relations 携带在 store 类型上（例如 react hooks 推导 include 结果）
     */
    readonly [RELATIONS_BRAND]?: Relations

    /** Add a new item */
    addOne(item: Partial<T>, options?: StoreOperationOptions): Promise<T>

    /** Add many items (single action) */
    addMany(items: Array<Partial<T>>, options?: StoreOperationOptions): Promise<T[]>

    /** Update an existing item (Immer recipe) */
    updateOne(id: EntityId, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions): Promise<T>

    /** Update many items (single action, per-item results) */
    updateMany(
        items: Array<{ id: EntityId; recipe: (draft: Draft<T>) => void }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>>

    /** Delete one item by ID */
    deleteOne(id: EntityId, options?: StoreOperationOptions): Promise<boolean>

    /** Delete many items by IDs (single action, per-item results) */
    deleteMany(ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>>

    /** Upsert one item (create if missing; update if exists) */
    upsertOne(item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<T>

    /** Upsert many items (single action, per-item results) */
    upsertMany(items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions): Promise<WriteManyResult<T>>

    /** Get one item by ID */
    getOne(id: EntityId, options?: StoreReadOptions): Promise<T | undefined>

    /** Fetch one from backend (bypass cache) */
    fetchOne(id: EntityId, options?: StoreReadOptions): Promise<T | undefined>

    /** 
     * Get all items 
     * @param filter - Filter items from backend
     * @param cacheFilter - Only cache items matching this filter (optimization)
     */
    getAll(filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: StoreReadOptions): Promise<T[]>

    /** Fetch all from backend */
    fetchAll?(): Promise<T[]>

    /** Get multiple items by IDs */
    getMany(ids: EntityId[], cache?: boolean, options?: StoreReadOptions): Promise<T[]>

    /** Query list */
    query?(query: Query<T>): Promise<QueryResult<T>>

    /** Query single item (limit=1) */
    queryOne?(query: Query<T>): Promise<QueryOneResult<T>>
}

/**
 * Store API shape used by hooks and external packages.
 *
 * 路线A：完全使用 client-assigned id，因此 store API 不再包含 server-assigned create 变体，也不再需要 “derived view 裁剪 API”。
 */
export type StoreApi<T extends Entity, Relations = {}> = IStore<T, Relations>
