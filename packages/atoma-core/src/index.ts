import { createActionId, createOpContext, normalizeOperationContext } from './operationContext'
import { executeLocalQuery, stableStringify } from './query'
import { belongsTo, hasMany, hasOne, variants } from './relations/builders'
import { RelationResolver } from './relations/RelationResolver'
import { collectRelationStoreTokens, projectRelationsBatch } from './relations/projector'
import { normalizeKey } from './relations/utils'
import { fuzzySearch } from './search'

export const Core = {
    operation: {
        createActionId,
        createOpContext,
        normalizeOperationContext
    },
    query: {
        executeLocalQuery,
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
    search: {
        fuzzySearch
    }
} as const

export {
    createActionId,
    createOpContext,
    normalizeOperationContext
} from './operationContext'

export { executeLocalQuery } from './query'
export { createRuntimeIo } from './runtime'
export { DataProcessor } from './store/internals/dataProcessor'
export type { StoreHandle } from './store/internals/handleTypes'
export { createStoreHandle } from './store/internals/storeHandleManager'
export { StoreStateWriter } from './store/internals/StoreStateWriter'
export { StoreWriteUtils } from './store/internals/StoreWriteUtils'
export { executeWriteOps } from './mutation/pipeline/WriteOps'
export {
    createAddOne,
    createAddMany,
    createUpdateOne,
    createUpdateMany,
    createDeleteOne,
    createDeleteMany,
    createUpsertOne,
    createUpsertMany,
    createGetAll,
    createGetMany,
    createBatchGet,
    createFetchAll,
    createQuery,
    createQueryOne
} from './store/ops'

export type {
    BelongsToConfig,
    DeleteItem,
    Entity,
    FetchPolicy,
    Query,
    QueryResult,
    QueryOneResult,
    FilterExpr,
    SortRule,
    PageSpec,
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
    RuntimeIo,
    RuntimeObservability,
    Persistence,
    StoreRegistry,
    RuntimeWrite,
    RuntimeMutation,
    RuntimePersistence,
    RuntimeTransform,
    WriteStrategy,
    PersistHandler,
    PersistRequest,
    PersistResult,
    PersistStatus,
    PersistAck,
    PartialWithId,
    StoreDispatchEvent,
    StoreOperationOptions,
    DataProcessor,
    DataProcessorContext,
    DataProcessorMode,
    DataProcessorStage,
    DataProcessorStageFn,
    DataProcessorValidate,
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
    WriteTicket,
    WriteManyResult
} from './types'

export { MutationPipeline } from './mutation/MutationPipeline'
export type { StoreCommit } from './mutation'
export type { StoreIndexes } from './indexes/StoreIndexes'
export type { FuzzySearchOptions, FuzzySearchResult } from './search'
export type { QueryMatcherOptions } from './query/QueryMatcher'
