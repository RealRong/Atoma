/**
 * Atoma Core
 * Universal state synchronization engine (framework-agnostic core)
 */

// Core factory function
export { createCoreStore } from './core/createCoreStore'
export type { CoreStore, CoreStoreConfig } from './core/createCoreStore'

// Core types
export type {
    IAdapter,
    IStore,
    IBase,
    BaseEntity,
    PartialWithId,
    StoreOperationOptions,
    StoreReadOptions,
    PatchMetadata,
    QueueConfig,
    Entity,
    SchemaValidator,
    LifecycleHooks,
    StoreKey,
    FindManyOptions,
    FindManyResult,
    FetchPolicy,

    PageInfo,
    IndexDefinition,
    IndexType,
    RelationMap,
    RelationConfig,
    BelongsToConfig,
    HasManyConfig,
    HasOneConfig,
    VariantsConfig,
    VariantBranch,
    KeySelector,
    // Core
    HistoryChange,
    IEventEmitter
} from './core/types'
export { createStore } from './core/createCoreStore'

// Observability
export type { TraceContext, Explain } from './observability'
export type { DebugEvent } from './observability/types'

// Core utilities
export { BaseStore, globalStore } from './core/BaseStore'
export { setDefaultIdGenerator, defaultSnowflakeGenerator } from './core/idGenerator'

// Adapters
export { IndexedDBAdapter } from './adapters/IndexedDBAdapter'
export { HTTPAdapter } from './adapters/HTTPAdapter'
export { HybridAdapter } from './adapters/HybridAdapter'
export { SQLiteHttpAdapter } from './adapters/SQLiteHttpAdapter'
export { BatchEngine } from './batch'
export type { HTTPAdapterConfig, BatchQueryConfig } from './adapters/HTTPAdapter'
export type { QuerySerializerConfig } from './adapters/http/query'
export type { HybridAdapterConfig } from './adapters/HybridAdapter'

// Relations
export { RelationResolver } from './core/relations/RelationResolver'
export { belongsTo, hasMany, hasOne, variants } from './core/relations/builders'

// Devtools
export { createDevtoolsBridge } from './devtools/bridge'
export type { DevtoolsBridge, DevtoolsEvent, StoreSnapshot, IndexSnapshot, IndexQueryPlan, QueueItem, HistoryEntrySummary } from './devtools/types'
export { enableGlobalDevtools, getGlobalDevtools, disableGlobalDevtools } from './devtools/global'

// History
export { HistoryManager, applyPatchesOnAtom } from './history'
export type { HistoryRecord, HistoryManagerConfig } from './history'

// Server（Fetch 风格管道）
export {
    parseHttp,
    restMapping,
    executeRequest,
    validateAndNormalizeRequest,
    createAtomaServer,
    authzHelpers
} from './server'
export type {
    BatchRequest,
    BatchResponse,
    BatchResult,
    BatchOp,
    Action,
    IOrmAdapter,
    OrderByRule,
    CursorToken,
    Page,
    QueryParams,
    QueryResult,
    QueryResultOne,
    QueryResultMany,
    WriteOptions,
    OrmAdapterOptions,
    StandardError
} from './server'
export type {
    AtomaServerConfig,
    AtomaServerLogger,
    AtomaServerRoute,
    AtomaAuthzHooks
} from './server'
export { AtomaTypeormAdapter } from './server/typeorm'
export type { TypeormAdapterOptions } from './server/typeorm'
export { AtomaPrismaAdapter } from './server/prisma'
export type { PrismaAdapterOptions } from './server/prisma'
