import type { CandidateExactness, CandidateResult, IndexDefinition, IndexStats } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'

export interface IndexDriver<T> {
    readonly type: IndexDefinition<T>['type']
    readonly config: IndexDefinition<T>
    add(id: EntityId, value: unknown): void
    remove(id: EntityId, value: unknown): void
    clear(): void
    queryCandidates(condition: unknown): CandidateResult
    getStats(): IndexStats
    isDirty(): boolean
}

export type IndexQueryPlan = {
    timestamp: number
    whereFields: string[]
    perField: Array<{
        field: string
        status: 'no_index' | 'unsupported' | 'empty' | 'candidates'
        exactness?: CandidateExactness
        candidates?: number
    }>
    result: { kind: CandidateResult['kind']; exactness?: CandidateExactness; candidates?: number }
}
