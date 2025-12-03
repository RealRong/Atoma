import { IndexDefinition, StoreKey } from '../../types'
import { IndexStats } from '../types'

export interface IIndex<T> {
    readonly type: string
    readonly config: IndexDefinition<T>
    add(id: StoreKey, value: any): void
    remove(id: StoreKey, value: any): void
    clear(): void
    query(condition: any): Set<StoreKey> | undefined
    getStats(): IndexStats
    isDirty(): boolean
}
