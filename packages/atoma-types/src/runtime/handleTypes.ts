import type * as Types from '../core'
import type { StoreState } from './storeState'

/**
 * Store internal handle bindings.
 * - Internal store operations use it alongside CoreRuntime for cross-store abilities.
 * - Internal layers access state/config without bloating public store API.
 */
export type StoreHandle<T extends Types.Entity = any> = {
    state: StoreState<T>
    storeName: string
    relations?: () => any | undefined
    config: Readonly<{
        /** Store-level default write strategy (from schema). Can be overridden per operation via StoreOperationOptions.writeStrategy. */
        defaultWriteStrategy?: Types.WriteStrategy
        hooks: Types.StoreConfig<T>['hooks']
        idGenerator: Types.StoreConfig<T>['idGenerator']
        dataProcessor: Types.StoreConfig<T>['dataProcessor']
    }>
}
