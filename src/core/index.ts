export { createCoreStore, createStore } from './createCoreStore'
export type { CoreStore, CoreStoreConfig } from './createCoreStore'

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
    HistoryChange,
    IEventEmitter
} from './types'

export { BaseStore, globalStore, setHistoryCallback } from './BaseStore'
export { initializeLocalStore } from './initializeLocalStore'
export { setDefaultIdGenerator, defaultSnowflakeGenerator } from './idGenerator'

export { createDevtoolsBridge } from '../devtools/bridge'
export type { DevtoolsBridge, DevtoolsEvent, StoreSnapshot } from '../devtools/types'
export { enableGlobalDevtools, getGlobalDevtools, disableGlobalDevtools } from '../devtools/global'

