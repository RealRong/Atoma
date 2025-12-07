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
export type { HTTPAdapterConfig } from './adapters/HTTPAdapter'
export type { HybridAdapterConfig } from './adapters/HybridAdapter'

// Hooks
export { createUseValue, createUseAll } from './hooks'
export { createUseFindMany } from './hooks'

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
