import type { PrimitiveAtom } from 'jotai/vanilla'
import { bumpAtomVersion } from '../BaseStore'
import { IndexSynchronizer } from '../indexes/IndexSynchronizer'
import type { IndexManager } from '../indexes/IndexManager'
import type { StoreContext } from '../StoreContext'
import type { StoreKey } from '../types'

export function commitAtomMapUpdate<T>(params: {
    jotaiStore: any
    atom: PrimitiveAtom<Map<StoreKey, T>>
    before: Map<StoreKey, T>
    after: Map<StoreKey, T>
    context: StoreContext
    indexManager: IndexManager<T> | null
}) {
    const { jotaiStore, atom, before, after, context, indexManager } = params

    jotaiStore.set(atom, after)
    if (indexManager) IndexSynchronizer.applyMapDiff(indexManager, before, after)
    bumpAtomVersion(atom, undefined, context)
}

