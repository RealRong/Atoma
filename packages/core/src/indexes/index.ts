import type { FilterExpr, Hits, IndexDefinition, IndexStats, StoreChange } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { NumberDateIndex } from './impl/NumberDateIndex'
import { StringIndex } from './impl/StringIndex'
import { SubstringIndex } from './impl/SubstringIndex'
import { TextIndex } from './impl/TextIndex'
import { plan } from './internal/plan'
import type { Index } from './types'

export class Indexes<T extends { id: EntityId }> {
    private readonly indexes = new Map<string, Index<T>>()

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

    query(filter?: FilterExpr<T>): Hits {
        return plan({ indexes: this.indexes, filter })
    }

    snapshot(): Array<{ field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats> {
        return Array.from(this.indexes, ([field, index]) => ({
            field,
            type: index.type,
            dirty: index.isDirty(),
            ...index.getStats()
        }))
    }

    apply(changes: ReadonlyArray<StoreChange<T>>) {
        for (const change of changes) {
            const prev = change.before
            const next = change.after
            if (prev === next) continue
            if (!prev) {
                if (next) this.add(next)
                continue
            }
            if (!next) {
                this.remove(prev)
                continue
            }
            this.update(prev, next)
        }
    }

    private update(previous: T, next: T): void {
        const id = previous.id
        this.indexes.forEach(index => {
            const field = index.config.field
            const previousValue = previous[field]
            const nextValue = next[field]
            if (previousValue === nextValue) return
            if (previousValue !== undefined && previousValue !== null) {
                index.remove(id, previousValue)
            }
            if (nextValue !== undefined && nextValue !== null) {
                index.add(id, nextValue)
            }
        })
    }

    private add(item: T): void {
        const id = item.id
        this.indexes.forEach(index => {
            const value = item[index.config.field]
            if (value !== undefined && value !== null) {
                index.add(id, value)
            }
        })
    }

    private remove(item: T): void {
        const id = item.id
        this.indexes.forEach(index => {
            const value = item[index.config.field]
            if (value !== undefined && value !== null) {
                index.remove(id, value)
            }
        })
    }
}
