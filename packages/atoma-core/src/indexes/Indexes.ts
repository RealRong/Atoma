import type { Patch } from 'immer'
import type { CandidateResult, FilterExpr, IndexDefinition, IndexStats } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { buildIndex } from './build'
import { planCandidates } from './plan'
import { IndexSync } from './IndexSync'
import type { IndexDriver, IndexQueryPlan } from './types'

function readEntityId<T>(item: T): EntityId {
    return (item as { id: EntityId }).id
}

function readFieldValue<T>(item: T, field: string): unknown {
    return (item as Record<string, unknown>)[field]
}

export class Indexes<T> {
    private readonly indexes = new Map<string, IndexDriver<T>>()
    private lastQueryPlan: IndexQueryPlan | undefined

    constructor(definitions: Array<IndexDefinition<T>>) {
        const seen = new Set<string>()
        definitions.forEach(definition => {
            if (seen.has(definition.field)) {
                throw new Error(`[Atoma Index] Duplicate index field "${definition.field}".`)
            }
            seen.add(definition.field)
            this.indexes.set(definition.field, buildIndex(definition))
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
        const planned = planCandidates({ indexes: this.indexes, filter })
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
        IndexSync.applyPatches({
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
        IndexSync.applyChangedIds({
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
        IndexSync.applyMapDiff({
            before,
            after,
            handler: {
                add: (item) => this.add(item),
                remove: (item) => this.remove(item)
            }
        })
    }
}
