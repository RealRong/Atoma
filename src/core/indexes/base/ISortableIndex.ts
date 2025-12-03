import { StoreKey } from '../../types'
import { IIndex } from './IIndex'

export interface ISortableIndex<T> extends IIndex<T> {
    getOrderedKeys(
        direction: 'asc' | 'desc',
        candidates?: Set<StoreKey>,
        opts?: { limit?: number; offset?: number }
    ): StoreKey[]
}
