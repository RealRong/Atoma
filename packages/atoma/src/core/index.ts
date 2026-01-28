import { createActionId, createOpContext, normalizeOperationContext } from './operationContext'
import { applyQuery, stableStringify } from './query'
import { belongsTo, hasMany, hasOne, variants } from './relations/builders'
import { RelationResolver } from './relations/RelationResolver'
import { collectRelationStoreTokens, projectRelationsBatch } from './relations/projector'
import { normalizeKey } from './relations/utils'
import { HistoryManager } from './history/HistoryManager'
import { fuzzySearch } from './search'

export const Core = {
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
    CoreRuntime,
    RuntimeObservability,
    RuntimeStores,
    Persistence,
    WriteStrategy,
    PersistRequest,
    PersistResult,
    PersistStatus,
    PersistAck,
    DataProcessor,
    DataProcessorContext,
    DataProcessorMode,
    DataProcessorStage,
    DataProcessorStageFn,
    DataProcessorValidate,
    OrderBy,
    PageInfo,
    PersistWriteback,
    RelationIncludeInput,
    RelationIncludeOptions,
    SchemaValidator,
    StoreConfig,
    StoreApi,
    StoreDataProcessor,
    StoreToken,
    UpsertWriteOptions,
    WithRelations,
    WhereOperator,
    WriteManyResult
} from './types'

export { MutationPipeline } from './mutation/MutationPipeline'
export type { MutationApi, MutationAcks } from './mutation/MutationPipeline'
export type { StoreIndexes } from './indexes/StoreIndexes'
export type { FuzzySearchOptions, FuzzySearchResult } from './search'
export type { QueryMatcherOptions } from './query/QueryMatcher'
