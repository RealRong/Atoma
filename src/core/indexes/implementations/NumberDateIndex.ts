import { IndexDefinition, IndexType, StoreKey } from '../../types'
import { binarySearchLeft, binarySearchRight } from '../utils'
import { normalizeNumber } from '../validators'
import { IndexStats } from '../types'
import { IIndex } from '../base/IIndex'
import { ISortableIndex } from '../base/ISortableIndex'

export class NumberDateIndex<T> implements ISortableIndex<T>, IIndex<T> {
    readonly type: 'number' | 'date'
    readonly config: IndexDefinition<T>

    private valueMap = new Map<number, Set<StoreKey>>()
    private sortedEntries: Array<{ value: number; ids: StoreKey[] }> | null = null
    private dirty = false

    constructor(config: IndexDefinition<T>) {
        if (config.type !== 'number' && config.type !== 'date') {
            throw new Error(`[Atoma Index] Invalid type "${config.type}" for NumberDateIndex.`)
        }
        this.type = config.type as IndexType
        this.config = config
    }

    add(id: StoreKey, value: any): void {
        const num = normalizeNumber(value, this.config.field, this.type as IndexType, id)
        const set = this.valueMap.get(num) || new Set<StoreKey>()
        set.add(id)
        this.valueMap.set(num, set)
        this.sortedEntries = null
        this.dirty = true
    }

    remove(id: StoreKey, value: any): void {
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

    query(condition: any): Set<StoreKey> | undefined {
        if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
            if (condition.in && Array.isArray(condition.in)) {
                const result = new Set<StoreKey>()
                condition.in.forEach((v: any) => {
                    try {
                        const num = normalizeNumber(v, this.config.field, this.type as IndexType, 'in')
                        const set = this.valueMap.get(num)
                        if (set) set.forEach(id => result.add(id))
                    } catch { /* ignore invalid */ }
                })
                return result
            }
            if (condition.gt !== undefined || condition.gte !== undefined || condition.lt !== undefined || condition.lte !== undefined) {
                return this.queryRange(condition)
            }
        }

        if (condition !== undefined) {
            try {
                const num = normalizeNumber(condition, this.config.field, this.type as IndexType, 'eq')
                return this.valueMap.get(num)
            } catch {
                return undefined
            }
        }
        return undefined
    }

    getOrderedKeys(
        direction: 'asc' | 'desc',
        candidates?: Set<StoreKey>,
        opts?: { limit?: number; offset?: number }
    ): StoreKey[] {
        const entries = this.buildSortedEntries()
        const asc = direction === 'asc'
        const ordered: StoreKey[] = []
        const limit = opts?.limit
        const offset = opts?.offset ?? 0
        let skipped = 0

        const processIds = (ids: StoreKey[]): boolean => {
            const list = asc ? ids : [...ids].reverse()
            for (const id of list) {
                if (candidates && !candidates.has(id)) continue
                if (skipped < offset) {
                    skipped++
                    continue
                }
                ordered.push(id)
                if (limit !== undefined && ordered.length >= limit) {
                    return true
                }
            }
            return false
        }

        if (asc) {
            for (let i = 0; i < entries.length; i++) {
                if (processIds(entries[i].ids)) break
            }
        } else {
            for (let i = entries.length - 1; i >= 0; i--) {
                if (processIds(entries[i].ids)) break
            }
        }

        return ordered
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

    private queryRange(cond: any): Set<StoreKey> {
        const entries = this.buildSortedEntries()
        const { gt, gte, lt, lte } = cond ?? {}

        let start = 0
        let end = entries.length

        if (gte !== undefined) {
            start = binarySearchLeft(entries, gte)
        } else if (gt !== undefined) {
            start = binarySearchRight(entries, gt)
        }

        if (lt !== undefined) {
            end = binarySearchLeft(entries, lt)
        } else if (lte !== undefined) {
            end = binarySearchRight(entries, lte)
        }

        const result = new Set<StoreKey>()
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
