import type { StoreHandle, StoreKey } from '../types'

export function commitAtomMapUpdate<T extends import('../types').Entity>(params: {
    handle: StoreHandle<T>
    before: Map<StoreKey, T>
    after: Map<StoreKey, T>
}) {
    const { handle, before, after } = params
    const { jotaiStore, atom, indexes } = handle

    jotaiStore.set(atom, after)
    indexes?.applyMapDiff(before, after)
    handle.services.mutation.versions.bump(handle.atom, new Set())
}
