import type { Entity, StoreConfig, StoreToken, ExecutionRoute } from '../../core'
import type { StoreState } from './state'

export type StoreHandle<T extends Entity = Entity> = {
    state: StoreState<T>
    storeName: StoreToken
    relations?: () => unknown | undefined
    config: Readonly<{
        defaultRoute?: ExecutionRoute
        idGenerator: StoreConfig<T>['idGenerator']
        dataProcessor: StoreConfig<T>['dataProcessor']
    }>
}
