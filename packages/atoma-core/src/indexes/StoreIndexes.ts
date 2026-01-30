import type { Patch } from 'immer'
import type { FilterExpr, IndexDefinition } from '../types'
import type { EntityId } from 'atoma-protocol'
import type { CandidateResult, IndexStats } from './types'
import { IndexManager } from './IndexManager'

export class StoreIndexes<T> {
    private manager: IndexManager<T>

    constructor(defs: Array<IndexDefinition<T>>) {
        this.manager = new IndexManager<T>(defs)
    }

    collectCandidates(filter?: FilterExpr): CandidateResult {
        return this.manager.collectCandidates(filter)
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

    applyPatches(before: Map<EntityId, T>, after: Map<EntityId, T>, patches: Patch[]) {
        const changedIds = new Set<EntityId>()
        patches.forEach(p => {
            const path = (p as any)?.path
            if (!Array.isArray(path) || path.length < 1) return
            changedIds.add(path[0] as any as EntityId)
        })

        changedIds.forEach(id => {
            const prev = before.get(id)
            const next = after.get(id)
            if (prev) this.manager.remove(prev)
            if (next) this.manager.add(next)
        })
    }

    applyChangedIds(before: Map<EntityId, T>, after: Map<EntityId, T>, changedIds: Iterable<EntityId>) {
        for (const id of changedIds) {
            const prev = before.get(id)
            const next = after.get(id)

            if (prev === next) continue
            if (prev) this.manager.remove(prev)
            if (next) this.manager.add(next)
        }
    }

    applyMapDiff(before: Map<EntityId, T>, after: Map<EntityId, T>) {
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
