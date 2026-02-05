import type * as Types from '../core'
import type { StoreState } from './storeState'

/**
 * Store internal handle bindings.
 * - Internal store operations use it alongside CoreRuntime for cross-store abilities.
 * - Internal layers access state/indexes without bloating public store API.
 */
export type StoreHandle<T extends Types.Entity = any> = {
    state: StoreState<T>
    matcher?: Types.QueryMatcherOptions
    storeName: string
    /** Store-level default write strategy (from schema). Can be overridden per operation via StoreOperationOptions.writeStrategy. */
    defaultWriteStrategy?: Types.WriteStrategy
    relations?: () => any | undefined
    indexes: Types.StoreIndexesLike<T> | null
    hooks: Types.StoreConfig<T>['hooks']
    idGenerator: Types.StoreConfig<T>['idGenerator']
    dataProcessor: Types.StoreConfig<T>['dataProcessor']

    /** 内部：生成本 store 的 opId */
    nextOpId: (prefix: 'q' | 'w') => string
}
