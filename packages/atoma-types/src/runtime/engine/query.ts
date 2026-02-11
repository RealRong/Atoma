import type { Entity, IndexQueryLike, PageInfo, Query } from '../../core'
import type { EntityId } from '../../shared'

export type QueryState<T extends Entity> = Readonly<{
    getSnapshot: () => ReadonlyMap<EntityId, T>
    indexes: IndexQueryLike<T> | null
}>

export type QueryEngine = Readonly<{
    evaluate: <T extends Entity>(args: {
        state: QueryState<T>
        query: Query<T>
    }) => { data: T[]; pageInfo?: PageInfo }
}>
