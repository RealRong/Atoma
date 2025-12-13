import type { Patch } from 'immer'
import type { StoreKey } from '../types'
import type { IndexManager } from './IndexManager'

type PatchKey = string | number

const isRootKeyPatch = (patch: Patch): patch is Patch & { path: [PatchKey] } => {
    return Array.isArray(patch.path) && patch.path.length === 1
}

export const IndexSynchronizer = {
    applyPatches<T>(
        indexManager: IndexManager<T>,
        before: Map<StoreKey, T>,
        after: Map<StoreKey, T>,
        patches: Patch[]
    ) {
        patches.forEach(patch => {
            if (!isRootKeyPatch(patch)) return
            const id = patch.path[0] as any as StoreKey
            if (patch.op === 'add') {
                const item = after.get(id)
                if (item) indexManager.add(item)
                return
            }
            if (patch.op === 'remove') {
                const item = before.get(id)
                if (item) indexManager.remove(item)
                return
            }
            if (patch.op === 'replace') {
                const prev = before.get(id)
                if (prev) indexManager.remove(prev)
                const next = after.get(id)
                if (next) indexManager.add(next)
            }
        })
    },

    applyMapDiff<T>(indexManager: IndexManager<T>, before: Map<StoreKey, T>, after: Map<StoreKey, T>) {
        // removals + updates
        before.forEach((prevItem, id) => {
            const nextItem = after.get(id)
            if (!nextItem) {
                indexManager.remove(prevItem)
                return
            }
            if (nextItem !== prevItem) {
                indexManager.remove(prevItem)
                indexManager.add(nextItem)
            }
        })

        // additions
        after.forEach((nextItem, id) => {
            if (!before.has(id)) {
                indexManager.add(nextItem)
            }
        })
    }
}

