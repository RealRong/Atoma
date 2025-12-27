import type { Patch } from 'immer'
import type { IndexDefinition, StoreKey, WhereOperator } from '../types'
import type { CandidateResult, IndexStats } from './types'
import { IndexManager } from './IndexManager'

export class StoreIndexes<T> {
    private manager: IndexManager<T>

    constructor(defs: Array<IndexDefinition<T>>) {
        this.manager = new IndexManager<T>(defs)
    }

    collectCandidates(where?: WhereOperator<T>): CandidateResult {
        return this.manager.collectCandidates(where)
    }

    getStats(field: string): IndexStats | undefined {
        return this.manager.getStats(field)
    }

    getIndexSnapshots(): Array<{ field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats> {
        return this.manager.getIndexSnapshots()
    }

    getLastQueryPlan() {
        return this.manager.getLastQueryPlan()
    }

    applyPatches(before: Map<StoreKey, T>, after: Map<StoreKey, T>, patches: Patch[]) {
        const changedIds = new Set<StoreKey>()
        patches.forEach(p => {
            const path = (p as any)?.path
            if (!Array.isArray(path) || path.length < 1) return
            changedIds.add(path[0] as any as StoreKey)
        })

        changedIds.forEach(id => {
            const prev = before.get(id)
            const next = after.get(id)
            if (prev) this.manager.remove(prev)
            if (next) this.manager.add(next)
        })
    }

    applyChangedIds(before: Map<StoreKey, T>, after: Map<StoreKey, T>, changedIds: Iterable<StoreKey>) {
        for (const id of changedIds) {
            const prev = before.get(id)
            const next = after.get(id)

            if (prev === next) continue
            if (prev) this.manager.remove(prev)
            if (next) this.manager.add(next)
        }
    }

    applyMapDiff(before: Map<StoreKey, T>, after: Map<StoreKey, T>) {
        // removals + updates
        before.forEach((prevItem, id) => {
            const nextItem = after.get(id)
            if (!nextItem) {
                this.manager.remove(prevItem)
                return
            }
            if (nextItem !== prevItem) {
                this.manager.remove(prevItem)
                this.manager.add(nextItem)
            }
        })

        // additions
        after.forEach((nextItem, id) => {
            if (!before.has(id)) {
                this.manager.add(nextItem)
            }
        })
    }
}
