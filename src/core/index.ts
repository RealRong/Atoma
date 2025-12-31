import { createStore } from './createStore'
import { createActionId, createOpContext, normalizeOperationContext } from './operationContext'
import { applyQuery, stableStringify } from './query'
import { belongsTo, hasMany, hasOne, variants } from './relations/builders'
import { RelationResolver } from './relations/RelationResolver'
import { collectRelationStoreTokens, projectRelationsBatch } from './relations/projector'
import { normalizeKey } from './relations/utils'
import { HistoryManager } from './history/HistoryManager'
import { getStoreHandle } from './storeHandleRegistry'
import { fuzzySearch } from './search'

export const Core = {
    store: {
        createStore,
        getHandle: getStoreHandle
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

export type * from './types'

export type { CoreStore, CoreStoreConfig } from './createStore'
export type { MutationPipeline, MutationRuntime, MutationControl } from './mutation/MutationPipeline'
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
