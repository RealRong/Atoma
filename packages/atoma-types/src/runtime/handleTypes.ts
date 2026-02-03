import type { PrimitiveAtom } from 'jotai/vanilla'
import type * as Types from '../core'
import type { EntityId } from '../protocol'

type ChangedIds = ReadonlyArray<EntityId> | ReadonlySet<EntityId>

export type StoreStateWriterApi<T extends Types.Entity = any> = {
    commitMapUpdate: (params: { before: Map<EntityId, T>; after: Map<EntityId, T> }) => void
    commitMapUpdateDelta: (params: { before: Map<EntityId, T>; after: Map<EntityId, T>; changedIds: ChangedIds }) => void
    applyWriteback: (args: Types.StoreWritebackArgs<T>, options?: { preserve?: (existing: T, incoming: T) => T }) => void
}

/**
 * Store internal handle bindings.
 * - Internal store operations use it alongside CoreRuntime for cross-store abilities.
 * - Internal layers access atom/jotaiStore/indexes without bloating public store API.
 */
export type StoreHandle<T extends Types.Entity = any> = {
    atom: PrimitiveAtom<Map<EntityId, T>>
    jotaiStore: Types.JotaiStore
    matcher?: Types.QueryMatcherOptions
    storeName: string
    /** Store-level default write strategy (from schema). Can be overridden per operation via StoreOperationOptions.writeStrategy. */
    defaultWriteStrategy?: Types.WriteStrategy
    relations?: () => any | undefined
    indexes: Types.StoreIndexesLike<T> | null
    hooks: Types.StoreConfig<T>['hooks']
    idGenerator: Types.StoreConfig<T>['idGenerator']
    dataProcessor: Types.StoreConfig<T>['dataProcessor']
    stateWriter: StoreStateWriterApi<T>
    commitMapUpdate: StoreStateWriterApi<T>['commitMapUpdate']
    commitMapUpdateDelta: StoreStateWriterApi<T>['commitMapUpdateDelta']
    applyWriteback: StoreStateWriterApi<T>['applyWriteback']

    /** 内部：生成本 store 的 opId */
    nextOpId: (prefix: 'q' | 'w') => string
}
