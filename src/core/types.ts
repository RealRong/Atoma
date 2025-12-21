import { Atom, PrimitiveAtom } from 'jotai/vanilla'
import type { Draft, Patch } from 'immer'
import type { StoreContext } from './StoreContext'
import type { DevtoolsBridge } from '../devtools/types'
import type { Explain, ObservabilityContext } from '#observability'
import type { QueryMatcherOptions } from './query/QueryMatcher'

/**
 * Base key type for entities
 */
export type StoreKey = string | number

/**
 * Minimal entity interface - all stored entities must have an id
 */
export interface Entity {
    id: StoreKey
}

/**
 * 键选择器：字段名、点路径或函数
 */
export type KeySelector<T> =
    | (keyof T & string)
    | string
    | ((item: T) => StoreKey | StoreKey[] | undefined | null)

/**
 * Base interface for all entities stored in the sync engine
 */
export interface IBase extends Entity {
    createdAt: number
    updatedAt: number
    deleted?: boolean
    deletedAt?: number
    version?: number      // Optional: for optimistic locking
    _etag?: string        // Optional: HTTP ETag for conflict detection
}

/**
 * 通用实体基类别名，包含 id / createdAt / updatedAt / deleted*
 */
export type BaseEntity = IBase

/**
 * Partial type with required id field
 */
export type PartialWithId<T> = Partial<T> & { id: StoreKey }

/**
 * Adapter interface - abstracts the storage backend
 */
export interface IAdapter<T extends Entity> {
    /** Adapter name for debugging */
    name: string

    /**
     * Store bindings (optional)
     * - Sync-enabled adapters can use this to write back remote changes into the store cache.
     */
    attachStoreAccess?: (access: StoreAccess<T>) => void
    detachStoreAccess?: () => void

    /**
     * Internal context (optional):
     * - Only adapters that perform I/O (e.g. HTTP) need to actually consume it.
     * - Other adapters can safely ignore the extra param.
     */
    /**  
     * Persistence operations
     */
    put(key: StoreKey, value: T, internalContext?: ObservabilityContext): Promise<void>
    bulkPut(items: T[], internalContext?: ObservabilityContext): Promise<void>
    bulkCreate?(items: T[], internalContext?: ObservabilityContext): Promise<T[] | void>
    delete(key: StoreKey, internalContext?: ObservabilityContext): Promise<void>
    bulkDelete(keys: StoreKey[], internalContext?: ObservabilityContext): Promise<void>

    /**
     * Retrieval operations
     */
    get(key: StoreKey, internalContext?: ObservabilityContext): Promise<T | undefined>
    bulkGet(keys: StoreKey[], internalContext?: ObservabilityContext): Promise<(T | undefined)[]>
    getAll(filter?: (item: T) => boolean, internalContext?: ObservabilityContext): Promise<T[]>

    /** Query operations (optional) */
    findMany?(
        options?: FindManyOptions<T>,
        internalContext?: ObservabilityContext
    ): Promise<{ data: T[]; pageInfo?: PageInfo; explain?: unknown }>

    /**
     * Patch-based update (optional, falls back to put) 
     */
    applyPatches?(patches: Patch[], metadata: PatchMetadata, internalContext?: ObservabilityContext): Promise<void | { created?: any[] }>

    /**
     * Lifecycle hooks
     */
    onConnect?(): Promise<void>
    onDisconnect?(): void

    /**
     * Error handling
     */
    onError?(error: Error, operation: string): void
}

/**
 * Metadata passed with patch operations
 */
export interface PatchMetadata {
    atom: Atom<any>
    databaseName?: string
    timestamp: number
    baseVersion?: number
    etag?: string         // Optional: ETag for HTTP conflict detection
    traceId?: string
}

/**
 * OperationContext：一次写入/一次动作的上下文载体（面向上层语义）
 * - scope 用于分区（history/batch/devtools 等）
 * - origin 用于区分来源（决定是否进入 history）
 * - actionId 用于将多个写入聚合为一次“用户动作”（撤销单位）
 */
export type OperationOrigin = 'user' | 'history' | 'sync' | 'system'

export type OperationContext = Readonly<{
    scope: string
    actionId?: string
    origin: OperationOrigin
    label?: string
    timestamp?: number
    traceId?: string
}>

/**
 * Dispatch event for queue processing
 */
export type StoreDispatchEvent<T extends Entity> = {
    atom: PrimitiveAtom<Map<StoreKey, T>>
    adapter: IAdapter<T>
    store: JotaiStore // Jotai store instance
    context: StoreContext // StoreContext for per-store dependencies (avoids circular import)
    indexes?: any
    observabilityContext: ObservabilityContext
    opContext?: OperationContext
    onFail?: (error?: Error) => void  // Accept error object for rejection
} & (
        | {
            type: 'add'
            data: PartialWithId<T>
            onSuccess?: (o: T) => void
        }
        | {
            type: 'update'
            data: PartialWithId<T>
            transformData?: (o: T) => T | undefined
            onSuccess?: (o: T) => void
        }
        | {
            type: 'remove'
            data: PartialWithId<T>
            onSuccess?: () => void
        }
        | {
            type: 'forceRemove'
            data: PartialWithId<T>
            onSuccess?: () => void
        }
        | {
            /**
             * Patch-based mutation (用于 history undo/redo 或其他高级场景)
             * - 需要 adapter.applyPatches 支持；否则会尝试降级为 bulkPut/bulkDelete（仅支持 Map 顶层 add/replace/remove）。
             */
            type: 'patches'
            patches: Patch[]
            inversePatches: Patch[]
            onSuccess?: () => void
        }
    )

/**
 * Options for store operations
 */
export interface StoreOperationOptions {
    force?: boolean
    traceId?: string
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
    traceId?: string
}

export type WhereOperator<T> = Partial<Record<keyof T & string, any | {
    eq?: any
    in?: any[]
    gt?: number
    gte?: number
    lt?: number
    lte?: number
    startsWith?: string
    endsWith?: string
    contains?: string
    match?: string | { q: string; op?: 'and' | 'or'; minTokenLength?: number; tokenizer?: (text: string) => string[] }
    fuzzy?: string | { q: string; op?: 'and' | 'or'; distance?: 0 | 1 | 2; minTokenLength?: number; tokenizer?: (text: string) => string[] }
}>>

export type OrderBy<T> =
    | { field: keyof T & string, direction: 'asc' | 'desc' }
    | Array<{ field: keyof T & string, direction: 'asc' | 'desc' }>

export type FetchPolicy = 'local' | 'remote' | 'local-then-remote'

export type PageInfo = import('../protocol/batch/pagination').PageInfo

export interface FindManyOptions<T, Include extends Record<string, any> = {}> {
    where?: WhereOperator<T>
    orderBy?: OrderBy<T>
    /**
     * 请求后端仅返回指定字段（sparse fieldset）。
     * 注意：当指定 fields 时，查询结果默认视为 transient（不会写入 store），避免半字段对象污染缓存。
     */
    fields?: Array<keyof T & string>
    limit?: number
    offset?: number
    /**
     * Atoma server/adapter 的 keyset cursor token：
     * - after: 下一页（向后翻页）
     * - before: 上一页（向前翻页）
     * - cursor: 旧别名（等同 after）
     */
    after?: string
    before?: string
    cursor?: string
    /** offset 分页时是否返回 total（Atoma server REST/batch 支持；默认 true） */
    includeTotal?: boolean
    cache?: {
        key?: string
        tags?: string[]
        staleTime?: number
    }
    /** If true, fetched data will NOT be stored in the central atom or indexed. Use for high-volume read-only data. */
    skipStore?: boolean
    /** Relations include 配置 */
    include?: Include
    /** 仅用于关联一次调用链（可选）。不传时由 store 决定是否分配。 */
    traceId?: string
    /** 生成 explain 诊断产物（默认 false） */
    explain?: boolean
}

export type FindManyResult<T> = { data: T[]; pageInfo?: PageInfo; explain?: Explain }

// Relations include 专用（仅支持 Top-N 预览，不含分页）
export type RelationIncludeOptions<T, Include extends Record<string, any> = Record<string, any>> = Pick<FindManyOptions<T, Include>, 'limit' | 'orderBy' | 'include' | 'skipStore'> & {
    /** live=true 订阅子 store 实时变化；false 则使用快照（默认 true） */
    live?: boolean
}

/**
 * Schema validator support (works with Zod/Yup or custom functions)
 */
export type SchemaValidator<T> =
    | ((data: T) => T | Promise<T>)
    | {
        parse: (data: unknown) => T
    }
    | {
        safeParse: (data: unknown) => { success: boolean; data: T; error?: unknown }
    }
    | {
        validateSync: (data: unknown) => T
    }
    | {
        validate: (data: unknown) => Promise<T> | T
    }

export interface LifecycleHooks<T> {
    beforeSave?: (args: { action: 'add' | 'update'; item: PartialWithId<T> }) => PartialWithId<T> | Promise<PartialWithId<T>>
    afterSave?: (args: { action: 'add' | 'update'; item: PartialWithId<T> }) => void | Promise<void>
}

/**
 * Store configuration options
 */
export interface StoreConfig<T> {
    /** Transform data before storing in atom */
    transformData?: (item: T) => T

    /** Custom ID generator (defaults to Snowflake-like generator) */
    idGenerator?: () => StoreKey

    /** Custom Jotai store instance */
    store?: JotaiStore  // ReturnType<typeof createStore> from 'jotai/vanilla'

    /** Optional schema validator (zod/yup/custom) */
    schema?: SchemaValidator<T>

    /** Lifecycle hooks for add/update */
    hooks?: LifecycleHooks<T>

    /** Optional index definitions (for findMany 优先命中) */
    indexes?: Array<IndexDefinition<T>>

    /** Per-store context for dependency injection (avoids circular import) */
    context?: StoreContext

    /** Devtools bridge（可选） */
    devtools?: DevtoolsBridge

    /** Store name（用于 devtools 标识） */
    storeName?: string

    /** 可观测性/诊断（默认关闭） */
    debug?: import('#observability').DebugConfig
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

// ============ Relations ============
export type RelationType = 'belongsTo' | 'hasMany' | 'hasOne' | 'variants'

export interface BelongsToConfig<TSource, TTarget extends Entity, TTargetRelations = {}> {
    type: 'belongsTo'
    store: IStore<TTarget, TTargetRelations>
    foreignKey: KeySelector<TSource>
    primaryKey?: keyof TTarget & string
    options?: RelationIncludeOptions<TTarget, Partial<{ [K in keyof TTargetRelations]: InferIncludeType<TTargetRelations[K]> }>>
}

export interface HasManyConfig<TSource, TTarget extends Entity, TTargetRelations = {}> {
    type: 'hasMany'
    store: IStore<TTarget, TTargetRelations>
    primaryKey?: KeySelector<TSource>
    foreignKey: keyof TTarget & string
    options?: RelationIncludeOptions<TTarget, Partial<{ [K in keyof TTargetRelations]: InferIncludeType<TTargetRelations[K]> }>>
}

export interface HasOneConfig<TSource, TTarget extends Entity, TTargetRelations = {}> {
    type: 'hasOne'
    store: IStore<TTarget, TTargetRelations>
    primaryKey?: KeySelector<TSource>
    foreignKey: keyof TTarget & string
    options?: RelationIncludeOptions<TTarget, Partial<{ [K in keyof TTargetRelations]: InferIncludeType<TTargetRelations[K]> }>>
}

export interface VariantsConfig<TSource> {
    type: 'variants'
    branches: Array<VariantBranch<TSource, any>>
}

export interface VariantBranch<TSource, TTarget extends Entity> {
    when: (item: TSource) => boolean
    relation: BelongsToConfig<TSource, TTarget> | HasManyConfig<TSource, TTarget> | HasOneConfig<TSource, TTarget>
}

export type RelationConfig<TSource, TTarget extends Entity = any> =
    | BelongsToConfig<TSource, TTarget>
    | HasManyConfig<TSource, TTarget>
    | HasOneConfig<TSource, TTarget>
    | VariantsConfig<TSource>

export type RelationMap<T> = Readonly<Record<string, RelationConfig<T, any>>>

// 根据关系类型推导 include 的取值类型
export type InferIncludeType<R> =
    R extends BelongsToConfig<any, infer TTarget, infer TR> ? boolean | RelationIncludeOptions<TTarget, Partial<{ [K in keyof TR]: InferIncludeType<TR[K]> }>>
    : R extends HasManyConfig<any, infer TTarget, infer TR> ? boolean | RelationIncludeOptions<TTarget, Partial<{ [K in keyof TR]: InferIncludeType<TR[K]> }>>
    : R extends HasOneConfig<any, infer TTarget, infer TR> ? boolean | RelationIncludeOptions<TTarget, Partial<{ [K in keyof TR]: InferIncludeType<TR[K]> }>>
    : never

/**
 * Store interface - main API for CRUD operations
 */
export interface IStore<T, Relations = {}> {
    /** Add a new item */
    addOne(item: Partial<T>, options?: StoreOperationOptions): Promise<T>

    /** Update an existing item (Immer recipe) */
    updateOne(id: StoreKey, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions): Promise<T>

    /** Delete an item by ID */
    deleteOneById(id: StoreKey, options?: StoreOperationOptions): Promise<boolean>

    /** Get one item by ID */
    getOneById(id: StoreKey, options?: StoreReadOptions): Promise<T | undefined>

    /** Fetch one from backend (bypass cache) */
    fetchOneById(id: StoreKey, options?: StoreReadOptions): Promise<T | undefined>

    /** 
     * Get all items 
     * @param filter - Filter items from backend
     * @param cacheFilter - Only cache items matching this filter (optimization)
     */
    getAll(filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: StoreReadOptions): Promise<T[]>

    /** Fetch all from backend */
    fetchAll?(): Promise<T[]>

    /** Get multiple items by IDs */
    getMultipleByIds(ids: StoreKey[], cache?: boolean, options?: StoreReadOptions): Promise<T[]>

    /** Query with filtering/sorting/paging */
    findMany?(options?: FindManyOptions<T>): Promise<FindManyResult<T>>
}

type InferTargetType<R> =
    R extends BelongsToConfig<any, infer U, any> ? U
    : R extends HasManyConfig<any, infer U, any> ? U
    : R extends HasOneConfig<any, infer U, any> ? U
    : R extends VariantsConfig<any> ? unknown
    : never

type InferStoreRelations<R> =
    R extends { store: IStore<any, infer TR> } ? TR : {}

type InferIncludeForRelations<Relations> =
    Partial<{ [K in keyof Relations]: InferIncludeType<Relations[K]> }>

type ApplyIncludeToTarget<
    TTarget,
    TTargetRelations,
    Opt
> = Opt extends { include?: infer Nested }
    ? Nested extends InferIncludeForRelations<TTargetRelations>
    ? WithRelations<TTarget, TTargetRelations, Nested>
    : WithRelations<TTarget, TTargetRelations, InferIncludeForRelations<TTargetRelations>>
    : TTarget

type InferRelationResultType<R, Opt> =
    0 extends (1 & R) ? any :
    R extends HasManyConfig<any, infer TTarget, any>
    ? ApplyIncludeToTarget<TTarget, InferStoreRelations<R>, Opt>[]
    : R extends BelongsToConfig<any, infer TTarget, any>
    ? ApplyIncludeToTarget<TTarget, InferStoreRelations<R>, Opt> | null
    : R extends HasOneConfig<any, infer TTarget, any>
    ? ApplyIncludeToTarget<TTarget, InferStoreRelations<R>, Opt> | null
    : R extends VariantsConfig<any> ? unknown | null
    : never

export type WithRelations<
    T,
    Relations,
    Include extends Record<string, any>
> = T & {
    [K in keyof Include as Include[K] extends false | undefined ? never : K]: K extends keyof Relations
    ? Include[K] extends true | object
    ? InferRelationResultType<Relations[K], Include[K]>
    : never
    : unknown
}

/**
 * Relations include 的入参形状：
 * - 当 Relations 可枚举（有明确的 key union）时：强约束 key，并为每个 key 推导值类型
 * - 当 Relations 不可得（空 / any / string 索引）时：允许任意 key，但不会把 any 泄漏到实体字段上（会在 WithRelations 里降级为 unknown）
 */
export type RelationIncludeInput<Relations> =
    keyof Relations extends never
    ? Partial<Record<string, boolean | RelationIncludeOptions<any, any>>>
    : string extends keyof Relations
    ? Partial<Record<string, boolean | RelationIncludeOptions<any, any>>>
    : Partial<{ [K in keyof Relations]: InferIncludeType<Relations[K]> }>

/**
 * Optimistic mode configuration
 * - optimistic: UI updates immediately, adapter failures only rollback locally
 * - strict: UI updates only after adapter confirms success
 */
export type OptimisticMode = 'optimistic' | 'strict'

/**
 * Queue configuration
 */
export interface QueueConfig {
    /** Enable batch processing */
    enabled: boolean

    /** Success/failure mode (default: 'optimistic' for backward compatibility) */
    mode?: OptimisticMode

    /** Log queue operations */
    debug?: boolean
}

/**
 * History change record
 */
export interface HistoryChange {
    patches: Patch[]
    inversePatches: Patch[]
    atom: Atom<any>
    databaseName?: string
    timestamp: number
}

/**
 * Event emitter type
 */
export type EventHandler<T = any> = (data: T) => void

export interface IEventEmitter {
    on(event: string, handler: EventHandler): void
    off(event: string, handler: EventHandler): void
    emit(event: string, data?: any): void
}

/** Helper type alias for Jotai store to reduce `any` usage */
export type JotaiStore = ReturnType<typeof import('jotai/vanilla').createStore>

/**
 * Store access bindings exposed to adapters（可选）。
 * 主要用于 sync/pull/subscribe 这类“服务端推动”的写回场景。
 */
export type StoreAccess<T extends Entity = any> = {
    atom: PrimitiveAtom<Map<StoreKey, T>>
    jotaiStore: JotaiStore
    context: StoreContext
    adapter?: IAdapter<T>
    matcher?: QueryMatcherOptions
    storeName?: string
    relations?: () => any | undefined
    createObservabilityContext?: (args?: { traceId?: string; explain?: boolean }) => ObservabilityContext

    transform?: (item: T) => T
    schema?: SchemaValidator<T>
    indexes?: any
}
