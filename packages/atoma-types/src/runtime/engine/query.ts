import type { Entity, Query } from '../../core'
import type { StoreState } from '../storeState'
import type { RuntimeCacheWriteDecision } from './shared'

export type RuntimeQuery = Readonly<{
    evaluate: <T extends Entity>(args: {
        state: StoreState<T>
        query: Query<T>
    }) => { data: T[]; pageInfo?: unknown }
    cachePolicy: <T>(query?: Query<T>) => RuntimeCacheWriteDecision
}>
