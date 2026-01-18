import { createStore } from './createStore'
import { createActionId, createOpContext, normalizeOperationContext } from './operationContext'
import { applyQuery, stableStringify } from './query'
import { belongsTo, hasMany, hasOne, variants } from './relations/builders'
import { RelationResolver } from './relations/RelationResolver'
import { collectRelationStoreTokens, projectRelationsBatch } from './relations/projector'
import { normalizeKey } from './relations/utils'
import { HistoryManager } from './history/HistoryManager'
import { fuzzySearch } from './search'
import { createDirectStoreView } from './store/createDirectStoreView'
import { createSyncStoreView } from './store/createSyncStoreView'

export const Core = {
    store: {
        createStore,
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
    IStore,
    JotaiStore,
    KeySelector,
    LifecycleHooks,
    OpsClientLike,
    OperationContext,
    OperationOrigin,
    OutboxEnqueuer,
    OutboxQueueMode,
    OutboxRuntime,
    ClientRuntime,
    OrderBy,
    PageInfo,
    PersistWriteback,
    RelationIncludeInput,
    RelationIncludeOptions,
    SchemaValidator,
    StoreConfig,
    StoreHandleOwner,
    StoreToken,
    UpsertWriteOptions,
    WithRelations,
    WhereOperator,
    WriteManyResult
} from './types'

export { applyStoreWriteback } from './store/internals/writeback'

export type { CoreStore, CoreStoreConfig } from './createStore'
export { MutationPipeline } from './mutation/MutationPipeline'
export type { MutationApi, MutationAcks } from './mutation/MutationPipeline'
export type {
    PersistResult
} from './mutation'
export type { StoreIndexes } from './indexes/StoreIndexes'
export type { FuzzySearchOptions, FuzzySearchResult } from './search'

export type { SyncStore } from './store/createSyncStoreView'
