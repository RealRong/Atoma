import type { StoreHandle } from '../../types'
import type { EntityId } from '#protocol'

export type ChangedIds = ReadonlyArray<EntityId> | ReadonlySet<EntityId>

export function commitAtomMapUpdate<T extends import('../../types').Entity>(params: {
    handle: StoreHandle<T>
    before: Map<EntityId, T>
    after: Map<EntityId, T>
}) {
    const { handle, before, after } = params
    const { jotaiStore, atom, indexes } = handle

    if (before === after) return

    jotaiStore.set(atom, after)
    indexes?.applyMapDiff(before, after)
}

export function commitAtomMapUpdateDelta<T extends import('../../types').Entity>(params: {
    handle: StoreHandle<T>
    before: Map<EntityId, T>
    after: Map<EntityId, T>
    changedIds: ChangedIds
}) {
    const { handle, before, after, changedIds } = params
    const { jotaiStore, atom, indexes } = handle

    if (before === after) return

    const size = Array.isArray(changedIds)
        ? changedIds.length
        : (changedIds as ReadonlySet<EntityId>).size
    if (size === 0) return

    jotaiStore.set(atom, after)
    indexes?.applyChangedIds(before, after, changedIds)
}
