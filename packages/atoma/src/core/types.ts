import { Atom } from 'jotai/vanilla'
import type { Draft, Patch } from 'immer'
import type { StoreHandle } from './store/internals/handleTypes'
import type { DebugConfig, DebugEvent, Explain, ObservabilityContext } from '#observability'
import type { EntityId, Meta, Operation, OperationResult, WriteAction, WriteItem, WriteOptions, WriteResultData } from '#protocol'
import type { StoreCommit } from './mutation'

/**
 * Minimal entity interface - all stored entities must have an id
 */
export interface Entity {
    id: EntityId
}

/**
 * 键选择器：字段名、点路径或函数
 */
export type KeySelector<T> =
    | (keyof T & string)
    | string
    | ((item: T) => EntityId | EntityId[] | undefined | null)

/**
 * Base interface for all entities stored in the sync engine
 */
export interface IBase extends Entity {
    createdAt: number
    updatedAt: number
    deleted?: boolean
    deletedAt?: number
    version?: number      // Optional: for optimistic locking
}

/**
 * 通用实体基类别名，包含 id / createdAt / updatedAt / deleted*
 */
export type BaseEntity = IBase

/**
 * Partial type with required id field
 */
export type PartialWithId<T> = Partial<T> & { id: EntityId }

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

/**
 * Writeback payload for applying remote changes to memory/durable stores.
 */
export type PersistWriteback<T extends Entity> = Readonly<{
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: Array<{ key: EntityId; version: number }>
}>

/**
 * Persist ack (server authoritative response for a write batch).
 * - Used to override local state with server versions/data when available.
 */
export type PersistAck<T extends Entity> = Readonly<{
    created?: T[]
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: Array<{ key: EntityId; version: number }>
}>

export type OpsClientLike = {
    executeOps: (input: {
        ops: Operation[]
        meta: Meta
        signal?: AbortSignal
        context?: ObservabilityContext
    }) => Promise<{
        results: OperationResult[]
        status?: number
    }>
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
}>

/**
 * 写入确认语义（只影响 `await store.addOne/updateOne/delete...` 何时完成）
 * - optimistic：等待 enqueued（持久化层已接管：例如已提交、已入队、已持久化到本地等）
 * - strict：等待 confirmed（持久化层已确认：例如远端返回最终结果/版本）
 */
export type WriteConfirmation = 'optimistic' | 'strict'

export type WriteTimeoutBehavior = 'reject' | 'resolve-enqueued'

/**
 * WriteItemMeta（每个 write item 的 meta，会发到服务端）
 * - 只放“跨重试仍稳定”的字段（idempotencyKey/clientTimeMs）
 */
export type WriteItemMeta = {
    idempotencyKey: string
    clientTimeMs: number
}

/**
 * 内部票据（每次写入调用一张）
 * - 只存在于内存
 * - 用于统一 await 语义（enqueued/confirmed）
 */
export type WriteTicket = {
    idempotencyKey: string
    clientTimeMs: number
    enqueued: Promise<void>
    confirmed: Promise<void>
    settle: (stage: 'enqueued' | 'confirmed', error?: unknown) => void
}

/**
 * Dispatch event for queue processing
 */
export type StoreDispatchEvent<T extends Entity> = {
    handle: StoreHandle<T>
    opContext?: OperationContext
    onFail?: (error?: Error) => void  // Accept error object for rejection
    ticket?: WriteTicket
    /**
     * 内部：显式写入策略（默认 undefined）。
     * - core 不关心策略的语义，只负责把它透传给 `CoreRuntime.persistence.persist`
     * - 例如 client 层可用 'direct' / 'queue' / 'local-first' 等实现策略选择
     */
    writeStrategy?: WriteStrategy
} & (
        | {
            type: 'add'
            data: PartialWithId<T>
            onSuccess?: (o: T) => void
        }
        | {
            type: 'upsert'
            data: PartialWithId<T>
            upsert?: UpsertWriteOptions
            onSuccess?: (o: T) => void
        }
        | {
            type: 'update'
            data: PartialWithId<T>
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
            type: 'hydrate'
            data: PartialWithId<T>
        }
        | {
            type: 'hydrateMany'
            items: Array<PartialWithId<T>>
        }
        | {
            /**
             * Patch-based mutation (用于 history undo/redo 或其他高级场景)
             * - 语义：不会逐条把 patches 应用到后端，而是按受影响 id 做 restore/replace（bulkUpsert merge=false + 版本化 bulkDelete）
             * - 具体“如何持久化”（立即执行/延迟入队/本地优先）由 `CoreRuntime.persistence.persist` 决定
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

export type Query<T = any> = import('#protocol').Query
export type FilterExpr<T = any> = import('#protocol').FilterExpr
export type SortRule<T = any> = import('#protocol').SortRule
export type PageSpec = import('#protocol').PageSpec
export type PageInfo = import('#protocol').PageInfo

export type FetchPolicy = 'cache-only' | 'network-only' | 'cache-and-network'

export type QueryResult<T> = { data: T[]; pageInfo?: PageInfo; explain?: Explain }
export type QueryOneResult<T> = { data?: T; explain?: Explain }

// Relations include 专用（仅支持 Top-N 预览，不含分页）
export type RelationIncludeOptions<T, Include extends Record<string, any> = Record<string, any>> = Pick<Query<T>, 'sort' | 'page' | 'include' | 'select'> & {
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

export type DataProcessorMode = 'inbound' | 'writeback' | 'outbound'

export type DataProcessorStage = 'deserialize' | 'normalize' | 'transform' | 'validate' | 'sanitize' | 'serialize'

export type DataProcessorBaseContext<T> = Readonly<{
    storeName: string
    runtime: CoreRuntime
    opContext?: OperationContext
    adapter?: unknown
}>

export type DataProcessorContext<T> = DataProcessorBaseContext<T> & Readonly<{
    mode: DataProcessorMode
    stage: DataProcessorStage
}>

export type DataProcessorStageFn<T> = (value: T, context: DataProcessorContext<T>) => T | undefined | Promise<T | undefined>

export type DataProcessorValidate<T> = SchemaValidator<T> | DataProcessorStageFn<T>

export type StoreDataProcessor<T> = Readonly<{
    deserialize?: DataProcessorStageFn<T>
    normalize?: DataProcessorStageFn<T>
    transform?: DataProcessorStageFn<T>
    validate?: DataProcessorValidate<T>
    sanitize?: DataProcessorStageFn<T>
    serialize?: DataProcessorStageFn<T>
}>

export type DataProcessor = Readonly<{
    process: <T>(mode: DataProcessorMode, data: T, context: DataProcessorBaseContext<T> & { dataProcessor?: StoreDataProcessor<T> }) => Promise<T | undefined>
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
}>

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

    /** 可观测性/诊断（默认关闭） */
    debug?: import('#observability').DebugConfig

    /** 可观测性/诊断：DebugEvent sink（dev-only / wiring 层注入） */
    debugSink?: (e: import('#observability').DebugEvent) => void
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

/**
 * Store token - currently a string (store name)
 */
export type StoreToken = string

/**
 * Write strategy (opaque to core).
 * - 用于 store view / 上层 wiring 选择不同的写入策略实现（例如 direct / queue / local-first）
 */
export type WriteStrategy = string

export type PersistStatus = 'confirmed' | 'enqueued'

export type TranslatedWriteOp = Readonly<{
    op: Operation
    action: 'create' | 'update' | 'upsert' | 'delete'
    entityId?: EntityId
    intent?: 'created'
    requireCreatedData?: boolean
}>

export type PersistRequest<T extends Entity> = Readonly<{
    storeName: StoreToken
    writeStrategy?: WriteStrategy
    handle: StoreHandle<T>
    writeOps: Array<TranslatedWriteOp>
    signal?: AbortSignal
    context?: ObservabilityContext
}>

export type PersistResult<T extends Entity> = Readonly<{
    status: PersistStatus
    ack?: PersistAck<T>
}>

export interface Persistence {
    persist: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}

/**
 * CoreRuntime：唯一上下文，承载跨 store 能力（ops/mutation/persistence/observability/resolveStore）
 */
export type StoreRegistry = Readonly<{
    resolve: (name: StoreToken) => IStore<any> | undefined
    ensure: (name: StoreToken) => IStore<any>
    list: () => Iterable<IStore<any>>
    onCreated: (listener: (store: IStore<any>) => void, options?: { replay?: boolean }) => () => void
    resolveHandle: (name: StoreToken, tag?: string) => StoreHandle<any>
}>

export interface RuntimeObservability {
    createContext: (storeName: StoreToken, args?: { traceId?: string; explain?: boolean }) => ObservabilityContext
    registerStore?: (args: { storeName: StoreToken; debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }) => void
}

export type RuntimeIo = Readonly<{
    executeOps: (args: { ops: Operation[]; signal?: AbortSignal; context?: ObservabilityContext }) => Promise<OperationResult[]>
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query, context?: ObservabilityContext, signal?: AbortSignal) => Promise<{ data: unknown[]; pageInfo?: any; explain?: any }>
    write: <T extends Entity>(handle: StoreHandle<T>, args: { action: WriteAction; items: WriteItem[]; options?: WriteOptions }, context?: ObservabilityContext, signal?: AbortSignal) => Promise<WriteResultData>
}>

export type RuntimeTransform = Readonly<{
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
}>

export type RuntimeWrite = Readonly<{
    resolveWriteStrategy: <T extends Entity>(handle: StoreHandle<T>, options?: StoreOperationOptions | undefined) => WriteStrategy | undefined
    allowImplicitFetchForWrite: (writeStrategy?: WriteStrategy) => boolean
    prepareForAdd: <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, opContext?: OperationContext) => Promise<PartialWithId<T>>
    prepareForUpdate: <T extends Entity>(handle: StoreHandle<T>, base: PartialWithId<T>, patch: PartialWithId<T>, opContext?: OperationContext) => Promise<PartialWithId<T>>
    runBeforeSave: <T>(hooks: LifecycleHooks<T> | undefined, item: PartialWithId<T>, action: 'add' | 'update') => Promise<PartialWithId<T>>
    runAfterSave: <T>(hooks: LifecycleHooks<T> | undefined, item: PartialWithId<T>, action: 'add' | 'update') => Promise<void>
    ensureActionId: (opContext: OperationContext | undefined) => OperationContext | undefined
    ignoreTicketRejections: (ticket: WriteTicket) => void
    dispatch: <T extends Entity>(event: StoreDispatchEvent<T>) => void
    applyWriteback: <T extends Entity>(handle: StoreHandle<T>, writeback: PersistWriteback<T>) => Promise<void>
}>

export type RuntimeMutation = Readonly<{
    begin: () => { ticket: WriteTicket; meta: WriteItemMeta }
    await: (ticket: WriteTicket, options?: StoreOperationOptions) => Promise<void>
    subscribeCommit: (listener: (commit: StoreCommit) => void) => () => void
    ack: (idempotencyKey: string) => void
    reject: (idempotencyKey: string, reason?: unknown) => void
}>

export type PersistHandler = <T extends Entity>(args: {
    req: PersistRequest<T>
    next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
}) => Promise<PersistResult<T>>

export type RuntimePersistence = Readonly<{
    register: (key: WriteStrategy, handler: PersistHandler) => () => void
    persist: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}>

export type CoreRuntime = Readonly<{
    id: string
    now: () => number
    stores: StoreRegistry
    io: RuntimeIo
    write: RuntimeWrite
    mutation: RuntimeMutation
    persistence: RuntimePersistence
    observe: RuntimeObservability
    transform: RuntimeTransform
}>

export interface BelongsToConfig<TSource, TTarget extends Entity, TTargetRelations = {}> {
    type: 'belongsTo'
    store: StoreToken
    foreignKey: KeySelector<TSource>
    primaryKey?: keyof TTarget & string
    options?: RelationIncludeOptions<TTarget, Partial<{ [K in keyof TTargetRelations]: InferIncludeType<TTargetRelations[K]> }>>
}

export interface HasManyConfig<TSource, TTarget extends Entity, TTargetRelations = {}> {
    type: 'hasMany'
    store: StoreToken
    primaryKey?: KeySelector<TSource>
    foreignKey: keyof TTarget & string
    options?: RelationIncludeOptions<TTarget, Partial<{ [K in keyof TTargetRelations]: InferIncludeType<TTargetRelations[K]> }>>
}

export interface HasOneConfig<TSource, TTarget extends Entity, TTargetRelations = {}> {
    type: 'hasOne'
    store: StoreToken
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

declare const RELATIONS_BRAND: unique symbol

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

type InferStoreRelations<R> =
    R extends BelongsToConfig<any, any, infer TR> ? TR
    : R extends HasManyConfig<any, any, infer TR> ? TR
    : R extends HasOneConfig<any, any, infer TR> ? TR
    : {}

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
