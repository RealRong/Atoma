import type { Entity, StoreConfig, StoreToken } from '../../core'
import type { EntityId } from '../../shared'
import type { StoreState } from './state'

export type StoreHandle<T extends Entity = Entity> = {
    state: StoreState<T>
    storeName: StoreToken
    relations?: () => unknown | undefined
    id: () => EntityId
    processor: StoreConfig<T>['processor']
}
