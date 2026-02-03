import type { IndexDefinition } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { CandidateResult, IndexStats } from 'atoma-types/core'

export interface IIndex<T> {
    readonly type: string
    readonly config: IndexDefinition<T>
    add(id: EntityId, value: any): void
    remove(id: EntityId, value: any): void
    clear(): void
    queryCandidates(condition: any): CandidateResult
    getStats(): IndexStats
    isDirty(): boolean
}