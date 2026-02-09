import type { Entity, StoreConfig, WriteStrategy } from '../core'
import type { StoreState } from './storeState'

export type StoreHandle<T extends Entity = Entity> = {
    state: StoreState<T>
    storeName: string
    relations?: () => unknown | undefined
    config: Readonly<{
        defaultWriteStrategy?: WriteStrategy
        hooks: StoreConfig<T>['hooks']
        idGenerator: StoreConfig<T>['idGenerator']
        dataProcessor: StoreConfig<T>['dataProcessor']
    }>
}
