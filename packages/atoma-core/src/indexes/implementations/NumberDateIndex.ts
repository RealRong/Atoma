import type { IndexDefinition, IndexType } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { binarySearchLeft, binarySearchRight } from '../utils'
import { normalizeNumber } from '../validators'
import type { CandidateResult, IndexStats } from 'atoma-types/core'
import { IIndex } from '../base/IIndex'

export class NumberDateIndex<T> implements IIndex<T> {
    readonly type: 'number' | 'date'
    readonly config: IndexDefinition<T>

    private valueMap = new Map<number, Set<EntityId>>()
    private sortedEntries: Array<{ value: number; ids: EntityId[] }> | null = null
    private dirty = false

    constructor(config: IndexDefinition<T> & { type: 'number' | 'date' }) {
        this.type = config.type
        this.config = config
    }

    add(id: EntityId, value: unknown): void {
        const num = normalizeNumber(value, this.config.field, this.type as IndexType, id)
        const set = this.valueMap.get(num) || new Set<EntityId>()
        set.add(id)
        this.valueMap.set(num, set)
        this.sortedEntries = null
        this.dirty = true
    }

    remove(id: EntityId, value: unknown): void {
        const num = normalizeNumber(value, this.config.field, this.type as IndexType, id)
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

    queryCandidates(condition: unknown): CandidateResult {
        if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
            const conditionObj = condition as Record<string, unknown> & { in?: unknown[] }
            if (conditionObj.eq !== undefined) {
                try {
                    const num = normalizeNumber(conditionObj.eq, this.config.field, this.type as IndexType, 'eq')
                    const set = this.valueMap.get(num)
                    if (!set || set.size === 0) return { kind: 'empty' }
                    return { kind: 'candidates', ids: set, exactness: 'exact' }
                } catch {
                    return { kind: 'empty' }
                }
            }
            if (conditionObj.in && Array.isArray(conditionObj.in)) {
                const result = new Set<EntityId>()
                conditionObj.in.forEach((value) => {
                    try {
                        const num = normalizeNumber(value, this.config.field, this.type as IndexType, 'in')
                        const set = this.valueMap.get(num)
                        if (set) set.forEach(id => result.add(id))
                    } catch { /* ignore invalid */ }
                })
                if (result.size === 0) return { kind: 'empty' }
                return { kind: 'candidates', ids: result, exactness: 'exact' }
            }
            if (conditionObj.gt !== undefined || conditionObj.gte !== undefined || conditionObj.lt !== undefined || conditionObj.lte !== undefined) {
                const result = this.queryRange(conditionObj)
                if (result.size === 0) return { kind: 'empty' }
                return { kind: 'candidates', ids: result, exactness: 'exact' }
            }
            return { kind: 'unsupported' }
        }

        if (condition !== undefined && condition !== null && (typeof condition !== 'object' || Array.isArray(condition))) {
            try {
                const num = normalizeNumber(condition, this.config.field, this.type as IndexType, 'eq')
                const set = this.valueMap.get(num)
                if (!set || set.size === 0) return { kind: 'empty' }
                return { kind: 'candidates', ids: set, exactness: 'exact' }
            } catch {
                return { kind: 'empty' }
            }
        }
        return { kind: 'unsupported' }
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

    private queryRange(cond: Record<string, unknown>): Set<EntityId> {
        const entries = this.buildSortedEntries()
        const { gt, gte, lt, lte } = cond ?? {}

        let start = 0
        let end = entries.length

        try {
            if (gte !== undefined) {
                const bound = normalizeNumber(gte, this.config.field, this.type as IndexType, 'gte')
                start = binarySearchLeft(entries, bound)
            } else if (gt !== undefined) {
                const bound = normalizeNumber(gt, this.config.field, this.type as IndexType, 'gt')
                start = binarySearchRight(entries, bound)
            }

            if (lt !== undefined) {
                const bound = normalizeNumber(lt, this.config.field, this.type as IndexType, 'lt')
                end = binarySearchLeft(entries, bound)
            } else if (lte !== undefined) {
                const bound = normalizeNumber(lte, this.config.field, this.type as IndexType, 'lte')
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