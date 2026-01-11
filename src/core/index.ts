import { createStore } from './createStore'
import { createActionId, createOpContext, normalizeOperationContext } from './operationContext'
import { applyQuery, stableStringify } from './query'
import { belongsTo, hasMany, hasOne, variants } from './relations/builders'
import { RelationResolver } from './relations/RelationResolver'
import { collectRelationStoreTokens, projectRelationsBatch } from './relations/projector'
import { normalizeKey } from './relations/utils'
import { HistoryManager } from './history/HistoryManager'
import { attachStoreHandle, getStoreHandle } from './storeHandleRegistry'
import { fuzzySearch } from './search'
import { createDirectStoreView } from './store/createDirectStoreView'
import { createSyncStoreView } from './store/createSyncStoreView'

export const Core = {
    store: {
        createStore,
        getHandle: getStoreHandle,
        attachHandle: attachStoreHandle,
        createDirectStoreView,
        createSyncStoreView
    },
    operation: {
        createActionId,
        createOpContext,
        normalizeOperationContext
    },
    query: {
        applyQuery,
        stableStringify
    },
    relations: {
        RelationResolver,
        normalizeKey,
        collectRelationStoreTokens,
        projectRelationsBatch,
        belongsTo,
        hasMany,
        hasOne,
        variants
    },
    history: {
        HistoryManager
    },
    search: {
        fuzzySearch
    }
} as const

export type {
    BelongsToConfig,
    DeleteItem,
    Entity,
    FetchPolicy,
    FindManyOptions,
    FindManyResult,
    HasManyConfig,
    HasOneConfig,
    IDataSource,
    IStore,
    JotaiStore,
    KeySelector,
    LifecycleHooks,
    OperationContext,
    OperationOrigin,
    OutboxEnqueuer,
    OutboxQueueMode,
    OutboxRuntime,
    StoreServices,
    OrderBy,
    PageInfo,
    PersistWriteback,
    RelationIncludeInput,
    RelationIncludeOptions,
    SchemaValidator,
    StoreConfig,
    StoreHandle,
    StoreHandleOwner,
    StoreKey,
    StoreToken,
    UpsertWriteOptions,
    WithRelations,
    WhereOperator,
    WriteManyResult
} from './types'

export { OutboxPersister } from './mutation/pipeline/persisters/Outbox'
export { applyStoreWriteback } from './store/internals/writeback'

export type { CoreStore, CoreStoreConfig } from './createStore'
export { MutationPipeline } from './mutation/MutationPipeline'
export type { MutationRuntime, MutationControl } from './mutation/MutationPipeline'
export type {
    AfterPersistEvent,
    BeforeDispatchContext,
    BeforePersistContext,
    CommittedEvent,
    DispatchDecision,
    Extensions,
    Middleware,
    MutationHooks,
    Observer,
    PersistErrorEvent,
    PlannedEvent,
    RolledBackEvent,
    RemoteAckEvent,
    RemotePullEvent,
    RemoteRejectEvent,
    PersistResult
} from './mutation'
export type { StoreIndexes } from './indexes/StoreIndexes'
export type { FuzzySearchOptions, FuzzySearchResult } from './search'

export type { SyncStore } from './store/createSyncStoreView'
