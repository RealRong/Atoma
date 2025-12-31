import type { StoreHandle, StoreKey } from '../../types'

export type ChangedIds = ReadonlyArray<StoreKey> | ReadonlySet<StoreKey>

export function commitAtomMapUpdate<T extends import('../../types').Entity>(params: {
    handle: StoreHandle<T>
    before: Map<StoreKey, T>
    after: Map<StoreKey, T>
}) {
    const { handle, before, after } = params
    const { jotaiStore, atom, indexes } = handle

    if (before === after) return

    jotaiStore.set(atom, after)
    indexes?.applyMapDiff(before, after)
}

export function commitAtomMapUpdateDelta<T extends import('../../types').Entity>(params: {
    handle: StoreHandle<T>
    before: Map<StoreKey, T>
    after: Map<StoreKey, T>
    changedIds: ChangedIds
}) {
    const { handle, before, after, changedIds } = params
    const { jotaiStore, atom, indexes } = handle

    if (before === after) return

    const size = Array.isArray(changedIds)
        ? changedIds.length
        : (changedIds as ReadonlySet<StoreKey>).size
    if (size === 0) return

    jotaiStore.set(atom, after)
    indexes?.applyChangedIds(before, after, changedIds)
}
