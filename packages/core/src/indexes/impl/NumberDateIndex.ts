import type { IndexDefinition } from '@atoma-js/types/core'
import type { EntityId } from '@atoma-js/types/protocol'
import { binarySearchLeft, binarySearchRight } from '../../shared/search'
import { normalizeNumber } from '../internal/value'
import type { IndexStats } from '@atoma-js/types/core'
import type { Condition, Index, RangeCondition } from '../types'

export class NumberDateIndex<T> implements Index<T> {
    readonly type: 'number' | 'date'
    readonly config: IndexDefinition<T> & { type: 'number' | 'date' }

    private valueMap = new Map<number, Set<EntityId>>()
    private sortedEntries: Array<{ value: number; ids: EntityId[] }> | null = null
    private dirty = false

    constructor(config: IndexDefinition<T> & { type: 'number' | 'date' }) {
        this.type = config.type
        this.config = config
    }

    add(id: EntityId, value: unknown): void {
        const num = normalizeNumber(value, this.config.field, this.type, id)
        const set = this.valueMap.get(num) || new Set<EntityId>()
        set.add(id)
        this.valueMap.set(num, set)
        this.sortedEntries = null
        this.dirty = true
    }

    remove(id: EntityId, value: unknown): void {
        const num = normalizeNumber(value, this.config.field, this.type, id)
        const set = this.valueMap.get(num)
        if (set) {
            set.delete(id)
            if (set.size === 0) {
                this.valueMap.delete(num)
            }
            this.sortedEntries = null
            this.dirty = true
        }
    }

    clear(): void {
        this.valueMap.clear()
        this.sortedEntries = null
        this.dirty = true
    }

    query(condition: Condition): ReadonlySet<EntityId> | null {
        switch (condition.op) {
            case 'eq':
                try {
                    const num = normalizeNumber(condition.value, this.config.field, this.type, 'eq')
                    const set = this.valueMap.get(num)
                    return set ?? new Set<EntityId>()
                } catch {
                    return new Set<EntityId>()
                }
            case 'in': {
                const result = new Set<EntityId>()
                condition.values.forEach(value => {
                    try {
                        const num = normalizeNumber(value, this.config.field, this.type, 'in')
                        const set = this.valueMap.get(num)
                        if (set) set.forEach(id => result.add(id))
                    } catch {
                        // ignore invalid
                    }
                })
                return result
            }
            case 'range': {
                return this.queryRange(condition)
            }
            default:
                return null
        }
    }

    getStats(): IndexStats {
        let totalDocs = 0
        let maxSetSize = 0
        let minSetSize = Number.POSITIVE_INFINITY
        this.valueMap.forEach(set => {
            const size = set.size
            totalDocs += size
            if (size > maxSetSize) maxSetSize = size
            if (size < minSetSize) minSetSize = size
        })
        const distinctValues = this.valueMap.size
        return {
            totalDocs,
            distinctValues,
            avgSetSize: distinctValues ? totalDocs / distinctValues : 0,
            maxSetSize: distinctValues ? maxSetSize : 0,
            minSetSize: distinctValues ? minSetSize : 0
        }
    }

    isDirty(): boolean {
        return this.dirty
    }

    private queryRange(cond: RangeCondition): Set<EntityId> {
        const entries = this.buildSortedEntries()
        const { gt, gte, lt, lte } = cond

        let start = 0
        let end = entries.length

        try {
            if (gte !== undefined) {
                const bound = normalizeNumber(gte, this.config.field, this.type, 'gte')
                start = binarySearchLeft(entries, bound)
            } else if (gt !== undefined) {
                const bound = normalizeNumber(gt, this.config.field, this.type, 'gt')
                start = binarySearchRight(entries, bound)
            }

            if (lt !== undefined) {
                const bound = normalizeNumber(lt, this.config.field, this.type, 'lt')
                end = binarySearchLeft(entries, bound)
            } else if (lte !== undefined) {
                const bound = normalizeNumber(lte, this.config.field, this.type, 'lte')
                end = binarySearchRight(entries, bound)
            }
        } catch {
            return new Set()
        }

        const result = new Set<EntityId>()
        for (let i = start; i < end; i++) {
            entries[i].ids.forEach(id => result.add(id))
        }
        return result
    }

    private buildSortedEntries() {
        if (!this.sortedEntries) {
            this.sortedEntries = Array.from(this.valueMap.entries())
                .map(([value, ids]) => ({ value, ids: Array.from(ids) }))
                .sort((a, b) => a.value - b.value)
            this.dirty = false
        }
        return this.sortedEntries
    }
}
