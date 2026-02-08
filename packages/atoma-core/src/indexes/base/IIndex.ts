import type { CandidateResult, IndexDefinition, IndexStats } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'

export interface IIndex<T> {
    readonly type: IndexDefinition<T>['type']
    readonly config: IndexDefinition<T>
    add(id: EntityId, value: unknown): void
    remove(id: EntityId, value: unknown): void
    clear(): void
    queryCandidates(condition: unknown): CandidateResult
    getStats(): IndexStats
    isDirty(): boolean
}
