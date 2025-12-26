import { createCoreStore, createStore } from './createCoreStore'
import { BaseStore } from './BaseStore'
import { setDefaultIdGenerator, defaultSnowflakeGenerator } from './idGenerator'
import { createActionId, normalizeOperationContext } from './operationContext'
import { applyQuery, extractQueryFields, stableStringify } from './query'
import { belongsTo, hasMany, hasOne, variants } from './relations/builders'
import { RelationResolver } from './relations/RelationResolver'
import { normalizeKey } from './relations/utils'
import { HistoryManager } from './history/HistoryManager'
import { getStoreHandle } from './storeHandleRegistry'
import { commitAtomMapUpdate } from './store/cacheWriter'
import { validateWithSchema } from './store/validation'
import { fuzzySearch } from './search'

export const Core = {
    store: {
        createCoreStore,
        createStore,
        BaseStore,
        getHandle: getStoreHandle,
        cacheWriter: {
            commitAtomMapUpdate
        },
        validation: {
            validateWithSchema
        }
    },
    id: {
        setDefaultIdGenerator,
        defaultSnowflakeGenerator
    },
    operation: {
        createActionId,
        normalizeOperationContext
    },
    query: {
        applyQuery,
        extractQueryFields,
        stableStringify
    },
    relations: {
        RelationResolver,
        normalizeKey,
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

export type { CoreStore, CoreStoreConfig } from './createCoreStore'
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
