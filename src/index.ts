/**
 * React Sync Engine
 * Universal state synchronization for React applications
 */

// Main factory function
export { createSyncStore } from './core/createSyncStore'
export type { SyncStore, SyncStoreConfig } from './core/createSyncStore'

// Core types
export type {
    IAdapter,
    IStore,
    IBase,
    BaseEntity,
    PartialWithId,
    StoreOperationOptions,
    PatchMetadata,
    QueueConfig,
    Entity,
    SchemaValidator,
    LifecycleHooks,
    StoreKey,
    FindManyOptions,
    FindManyResult,
    UseFindManyResult,
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
export { createStore } from './core/createSyncStore'

// Core utilities
export { BaseStore, globalStore, setHistoryCallback } from './core/BaseStore'
export { initializeLocalStore } from './core/initializeLocalStore'
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
export { AtomaDevTools } from './devtools/AtomaDevTools'
export type { DevtoolsBridge, DevtoolsEvent, StoreSnapshot } from './devtools/types'
export { enableGlobalDevtools, getGlobalDevtools, disableGlobalDevtools } from './devtools/global'

// Hooks
export { createUseValue, createUseAll } from './hooks'
export { createUseFindMany } from './hooks'
export { createUseMultiple } from './hooks'

// History
export { HistoryManager, applyPatchesOnAtom } from './history'
export type { HistoryRecord, HistoryManagerConfig } from './history'

// StoreRegistry
export {
    Store,
    setDefaultAdapterFactory,
    registerStore,
    clearStoreCache,
    preloadStores,
    getLoadedStores,
    getStoreConfig,
    type AdapterFactoryOptions
} from './registry/StoreFactory'

export type {
    StoreRegistry,
    RegistryStoreConfig,
    AdapterFactory
} from './registry/types'

// Server（Fetch 风格管道）
export {
    parseHttp,
    restMapping,
    guardRequest,
    executeRequest,
    validateAndNormalizeRequest,
    createHandler
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
export { AtomaTypeormAdapter } from './server/typeorm'
export type { TypeormAdapterOptions } from './server/typeorm'
export { AtomaPrismaAdapter } from './server/prisma'
export type { PrismaAdapterOptions } from './server/prisma'
