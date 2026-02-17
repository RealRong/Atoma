import type { Entity, GetAllMergePolicy, StoreConfig, StoreToken, ExecutionRoute } from '../core'
import type { StoreState } from './storeState'

export type StoreHandle<T extends Entity = Entity> = {
    state: StoreState<T>
    storeName: StoreToken
    relations?: () => unknown | undefined
    config: Readonly<{
        defaultRoute?: ExecutionRoute
        getAllMergePolicy?: GetAllMergePolicy
        idGenerator: StoreConfig<T>['idGenerator']
        dataProcessor: StoreConfig<T>['dataProcessor']
    }>
}
