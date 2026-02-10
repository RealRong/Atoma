import type { CandidateResult, FilterExpr, IndexDefinition, IndexStats } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { NumberDateIndex } from './impl/NumberDateIndex'
import { StringIndex } from './impl/StringIndex'
import { SubstringIndex } from './impl/SubstringIndex'
import { TextIndex } from './impl/TextIndex'
import { planCandidates } from './plan'
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

            const indexType = definition.type
            switch (indexType) {
                case 'number':
                case 'date':
                    this.indexes.set(
                        definition.field,
                        new NumberDateIndex<T>(definition as IndexDefinition<T> & { type: 'number' | 'date' })
                    )
                    return
                case 'string':
                    this.indexes.set(definition.field, new StringIndex<T>(definition))
                    return
                case 'substring':
                    this.indexes.set(definition.field, new SubstringIndex<T>(definition))
                    return
                case 'text':
                    this.indexes.set(definition.field, new TextIndex<T>(definition))
                    return
                default:
                    throw new Error(`[Atoma Index] Unsupported index type "${String(indexType)}".`)
            }
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

    debugIndexSnapshots(): Array<{ field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats> {
        const snapshots: Array<{ field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats> = []

        this.indexes.forEach((index, field) => {
            snapshots.push({
                field,
                type: index.type,
                dirty: index.isDirty(),
                ...index.getStats()
            })
        })

        return snapshots
    }

    debugLastQueryPlan() {
        return this.lastQueryPlan
    }

    applyChangedIds(before: Map<EntityId, T>, after: Map<EntityId, T>, changedIds: Iterable<EntityId>) {
        for (const id of changedIds) {
            const prev = before.get(id)
            const next = after.get(id)
            if (prev === next) continue
            if (prev) this.remove(prev)
            if (next) this.add(next)
        }
    }
}
