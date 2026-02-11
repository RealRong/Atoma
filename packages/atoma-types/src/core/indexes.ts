import type { EntityId } from '../shared'
import type { FilterExpr } from './query'
import type { IndexDefinition } from './store'

export type IndexStats = {
    totalDocs: number
    distinctValues: number
    avgSetSize: number
    maxSetSize: number
    minSetSize: number
    totalTokens?: number
    avgDocTokens?: number
}

export type CandidateExactness = 'exact' | 'superset'

export type CandidateResult =
    | { kind: 'unsupported' }
    | { kind: 'empty' }
    | { kind: 'candidates'; ids: Set<EntityId>; exactness: CandidateExactness }

export type IndexSnapshot<T> = { field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats

export type IndexQueryLike<T> = Readonly<{
    collectCandidates: (filter?: FilterExpr<T>) => CandidateResult
}>

export type IndexSyncLike<T> = Readonly<{
    applyChangedIds: (before: Map<EntityId, T>, after: Map<EntityId, T>, changedIds: Iterable<EntityId>) => void
}>

export type IndexesLike<T> = IndexQueryLike<T> & IndexSyncLike<T>
