import type { Entity, PageInfo, Query } from '../../core'
import type { StoreState } from '../storeState'

export type RuntimeQuery = Readonly<{
    evaluate: <T extends Entity>(args: {
        state: StoreState<T>
        query: Query<T>
    }) => { data: T[]; pageInfo?: PageInfo }
}>
