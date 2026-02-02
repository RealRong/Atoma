import type { PrimitiveAtom } from 'jotai/vanilla'
import type { Entity, JotaiStore, StoreConfig, StoreWritebackArgs, WriteStrategy } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { QueryMatcherOptions, StoreIndexes } from 'atoma-core'

type ChangedIds = ReadonlyArray<EntityId> | ReadonlySet<EntityId>

export type StoreStateWriterApi<T extends Entity = any> = {
    commitMapUpdate: (params: { before: Map<EntityId, T>; after: Map<EntityId, T> }) => void
    commitMapUpdateDelta: (params: { before: Map<EntityId, T>; after: Map<EntityId, T>; changedIds: ChangedIds }) => void
    applyWriteback: (args: StoreWritebackArgs<T>, options?: { preserve?: (existing: T, incoming: T) => T }) => void
}

/**
 * Store internal handle bindings.
 * - Internal store operations use it alongside CoreRuntime for cross-store abilities.
 * - Internal layers access atom/jotaiStore/indexes without bloating public store API.
 */
export type StoreHandle<T extends Entity = any> = {
    atom: PrimitiveAtom<Map<EntityId, T>>
    jotaiStore: JotaiStore
    matcher?: QueryMatcherOptions
    storeName: string
    /** Store-level default write strategy (from schema). Can be overridden per operation via StoreOperationOptions.writeStrategy. */
    defaultWriteStrategy?: WriteStrategy
    relations?: () => any | undefined
    indexes: StoreIndexes<T> | null
    hooks: StoreConfig<T>['hooks']
    idGenerator: StoreConfig<T>['idGenerator']
    dataProcessor: StoreConfig<T>['dataProcessor']
    stateWriter: StoreStateWriterApi<T>
    commitMapUpdate: StoreStateWriterApi<T>['commitMapUpdate']
    commitMapUpdateDelta: StoreStateWriterApi<T>['commitMapUpdateDelta']
    applyWriteback: StoreStateWriterApi<T>['applyWriteback']

    /** 内部：生成本 store 的 opId */
    nextOpId: (prefix: 'q' | 'w') => string
}
