import type { Entity, StoreConfig, StoreToken } from '../../core'
import type { StoreState } from './state'

export type StoreHandle<T extends Entity = Entity> = {
    state: StoreState<T>
    storeName: StoreToken
    relations?: () => unknown | undefined
    config: Readonly<{
        createId: StoreConfig<T>['createId']
        processor: StoreConfig<T>['processor']
    }>
}
