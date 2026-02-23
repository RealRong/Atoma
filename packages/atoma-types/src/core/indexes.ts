import type { EntityId } from '../shared'
import type { Entity } from './entity'
import type { FilterExpr } from './query'
import type { IndexDefinition } from './store'
import type { StoreChange } from './writeback'

export type IndexStats = {
    totalDocs: number
    distinctValues: number
    avgSetSize: number
    maxSetSize: number
    minSetSize: number
    totalTokens?: number
    avgDocTokens?: number
}

export type Hits =
    | { kind: 'scan' }
    | { kind: 'hits'; ids: ReadonlySet<EntityId> }

export type IndexSnapshot<T> = { field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats

export type Indexes<T extends Entity> = Readonly<{
    query: (filter?: FilterExpr<T>) => Hits
    apply: (changes: ReadonlyArray<StoreChange<T>>) => void
    snapshot: () => IndexSnapshot<T>[]
}>
