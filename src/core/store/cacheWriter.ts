import type { PrimitiveAtom } from 'jotai/vanilla'
import { bumpAtomVersion } from '../BaseStore'
import type { StoreIndexes } from '../indexes/StoreIndexes'
import type { StoreContext } from '../StoreContext'
import type { StoreKey } from '../types'

export function commitAtomMapUpdate<T>(params: {
    jotaiStore: any
    atom: PrimitiveAtom<Map<StoreKey, T>>
    before: Map<StoreKey, T>
    after: Map<StoreKey, T>
    context: StoreContext
    indexes: StoreIndexes<T> | null
}) {
    const { jotaiStore, atom, before, after, context, indexes } = params

    jotaiStore.set(atom, after)
    indexes?.applyMapDiff(before, after)
    bumpAtomVersion(atom, undefined, context)
}
