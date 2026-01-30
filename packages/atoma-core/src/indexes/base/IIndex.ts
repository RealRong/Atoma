import { IndexDefinition } from '../../types'
import type { EntityId } from 'atoma-protocol'
import { CandidateResult, IndexStats } from '../types'

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
