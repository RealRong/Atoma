import type { Patch } from 'immer'
import type { CandidateResult, FilterExpr, IndexDefinition, IndexStats } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { IIndex } from './base/IIndex'
import { createIndex } from './factory/createIndex'
import { collectCandidatesWithPlan, type IndexQueryPlan } from './planner/IndexQueryPlanner'
import { IndexDeltaUpdater } from './updater/IndexDeltaUpdater'

function readEntityId<T>(item: T): EntityId {
    return (item as { id: EntityId }).id
}

function readFieldValue<T>(item: T, field: string): unknown {
    return (item as Record<string, unknown>)[field]
}

export class StoreIndexes<T> {
    private readonly indexes = new Map<string, IIndex<T>>()
    private lastQueryPlan: IndexQueryPlan | undefined

    constructor(defs: Array<IndexDefinition<T>>) {
        const seen = new Set<string>()
        defs.forEach(def => {
            if (seen.has(def.field)) {
                throw new Error(`[Atoma Index] Duplicate index field "${def.field}".`)
            }
            seen.add(def.field)
            this.indexes.set(def.field, createIndex(def))
        })
    }

    add(item: T): void {
        const id = readEntityId(item)
        this.indexes.forEach(index => {
            const value = readFieldValue(item, index.config.field)
            if (value !== undefined && value !== null) {
                index.add(id, value)
            }
        })
    }

    remove(item?: T): void {
        if (!item) return

        const id = readEntityId(item)
        this.indexes.forEach(index => {
            const value = readFieldValue(item, index.config.field)
            if (value !== undefined && value !== null) {
                index.remove(id, value)
            }
        })
    }

    rebuild(items: Iterable<T>): void {
        const source = Array.isArray(items) ? items : Array.from(items)
        this.indexes.forEach(index => index.clear())
        source.forEach(item => this.add(item))
    }

    collectCandidates(filter?: FilterExpr): CandidateResult {
        const planned = collectCandidatesWithPlan({ indexes: this.indexes, filter })
        this.lastQueryPlan = planned.plan
        return planned.result
    }

    getStats(field: string): IndexStats | undefined {
        return this.indexes.get(field)?.getStats()
    }

    getIndexSnapshots(): Array<{ field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats> {
        const list: Array<{ field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats> = []
        this.indexes.forEach((index, field) => {
            const stats = index.getStats()
            list.push({
                field,
                type: index.type,
                dirty: index.isDirty(),
                ...stats
            })
        })
        return list
    }

    getLastQueryPlan() {
        return this.lastQueryPlan
    }

    applyPatches(before: Map<EntityId, T>, after: Map<EntityId, T>, patches: Patch[]) {
        IndexDeltaUpdater.applyPatches({
            before,
            after,
            patches,
            handler: {
                add: (item) => this.add(item),
                remove: (item) => this.remove(item)
            }
        })
    }

    applyChangedIds(before: Map<EntityId, T>, after: Map<EntityId, T>, changedIds: Iterable<EntityId>) {
        IndexDeltaUpdater.applyChangedIds({
            before,
            after,
            changedIds,
            handler: {
                add: (item) => this.add(item),
                remove: (item) => this.remove(item)
            }
        })
    }

    applyMapDiff(before: Map<EntityId, T>, after: Map<EntityId, T>) {
        IndexDeltaUpdater.applyMapDiff({
            before,
            after,
            handler: {
                add: (item) => this.add(item),
                remove: (item) => this.remove(item)
            }
        })
    }
}
