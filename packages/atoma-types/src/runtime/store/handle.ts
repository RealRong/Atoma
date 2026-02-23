import type { Entity, RelationMap, StoreConfig, StoreToken } from '../../core'
import type { EntityId } from '../../shared'
import type { StoreState } from './state'

export type StoreHandle<T extends Entity = Entity, Relations = RelationMap<T>> = {
    state: StoreState<T>
    storeName: StoreToken
    relations?: () => Relations | undefined
    id: () => EntityId
    processor: StoreConfig<T>['processor']
}
