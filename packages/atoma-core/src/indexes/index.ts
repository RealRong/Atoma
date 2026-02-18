import type { CandidateResult, FilterExpr, IndexDefinition, IndexStats } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { NumberDateIndex } from './impl/NumberDateIndex'
import { StringIndex } from './impl/StringIndex'
import { SubstringIndex } from './impl/SubstringIndex'
import { TextIndex } from './impl/TextIndex'
import { planCandidates } from './plan'
import type { IndexDriver, IndexQueryPlan } from './types'

export class Indexes<T extends { id: EntityId }> {
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

    collectCandidates(filter?: FilterExpr<T>): CandidateResult {
        const planned = planCandidates({ indexes: this.indexes, filter })
        this.lastQueryPlan = planned.plan
        return planned.result
    }

    debugIndexSnapshots(): Array<{ field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats> {
        return Array.from(this.indexes, ([field, index]) => ({
            field,
            type: index.type,
            dirty: index.isDirty(),
            ...index.getStats()
        }))
    }

    debugLastQueryPlan() {
        return this.lastQueryPlan
    }

    applyChangedIds(before: Map<EntityId, T>, after: Map<EntityId, T>, changedIds: Iterable<EntityId>) {
        for (const id of changedIds) {
            const prev = before.get(id)
            const next = after.get(id)
            if (prev === next) continue
            if (prev) this.removeItem(prev)
            if (next) this.addItem(next)
        }
    }

    private addItem(item: T): void {
        const id = item.id
        this.indexes.forEach(index => {
            const value = item[index.config.field]
            if (value !== undefined && value !== null) {
                index.add(id, value)
            }
        })
    }

    private removeItem(item: T): void {
        const id = item.id
        this.indexes.forEach(index => {
            const value = item[index.config.field]
            if (value !== undefined && value !== null) {
                index.remove(id, value)
            }
        })
    }
}
