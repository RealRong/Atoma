import type { CandidateExactness, CandidateResult, IndexDefinition, IndexStats } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'

export type EqCondition = {
    op: 'eq'
    value: unknown
}

export type InCondition = {
    op: 'in'
    values: unknown[]
}

export type RangeCondition = {
    op: 'range'
    gt?: number
    gte?: number
    lt?: number
    lte?: number
}

export type StartsWithCondition = {
    op: 'startsWith'
    value: string
}

export type EndsWithCondition = {
    op: 'endsWith'
    value: string
}

export type ContainsCondition = {
    op: 'contains'
    value: string
}

export type MatchCondition = {
    op: 'match'
    value: { q: string }
}

export type FuzzyCondition = {
    op: 'fuzzy'
    value: { q: string; distance?: 0 | 1 | 2 }
}

export type IndexCondition =
    | EqCondition
    | InCondition
    | RangeCondition
    | StartsWithCondition
    | EndsWithCondition
    | ContainsCondition
    | MatchCondition
    | FuzzyCondition

export interface IndexDriver<T> {
    readonly type: IndexDefinition<T>['type']
    readonly config: IndexDefinition<T>
    add(id: EntityId, value: unknown): void
    remove(id: EntityId, value: unknown): void
    clear(): void
    queryCandidates(condition: IndexCondition): CandidateResult
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
