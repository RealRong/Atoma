import { IndexDefinition, StoreKey } from '../../types'
import { CandidateResult, IndexStats } from '../types'

export interface IIndex<T> {
    readonly type: string
    readonly config: IndexDefinition<T>
    add(id: StoreKey, value: any): void
    remove(id: StoreKey, value: any): void
    clear(): void
    queryCandidates(condition: any): CandidateResult
    getStats(): IndexStats
    isDirty(): boolean
}
