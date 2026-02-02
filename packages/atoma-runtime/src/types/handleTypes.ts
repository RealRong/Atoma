import type { PrimitiveAtom } from 'jotai/vanilla'
import type { Entity, JotaiStore, StoreConfig, WriteStrategy } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { QueryMatcherOptions, StoreIndexes } from 'atoma-core'

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

    /** 内部：生成本 store 的 opId */
    nextOpId: (prefix: 'q' | 'w') => string
}
