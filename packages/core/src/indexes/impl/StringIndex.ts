import type { IndexDefinition } from '@atoma-js/types/core'
import type { EntityId } from '@atoma-js/types/protocol'
import type { IndexStats } from '@atoma-js/types/core'
import { validateString } from '../internal/value'
import type { Condition, Index } from '../types'

export class StringIndex<T> implements Index<T> {
    readonly type = 'string'
    readonly config: IndexDefinition<T>

    private valueMap = new Map<string, Set<EntityId>>()

    constructor(config: IndexDefinition<T>) {
        this.config = config
    }

    add(id: EntityId, value: unknown): void {
        const str = validateString(value, this.config.field, id)
        const set = this.valueMap.get(str) || new Set<EntityId>()
        set.add(id)
        this.valueMap.set(str, set)
    }

    remove(id: EntityId, value: unknown): void {
        const str = validateString(value, this.config.field, id)
        const set = this.valueMap.get(str)
        if (set) {
            set.delete(id)
            if (set.size === 0) {
                this.valueMap.delete(str)
            }
        }
    }

    clear(): void {
        this.valueMap.clear()
    }

    query(condition: Condition): ReadonlySet<EntityId> | null {
        switch (condition.op) {
            case 'eq': {
                if (typeof condition.value !== 'string') return new Set<EntityId>()
                const set = this.valueMap.get(condition.value)
                return set ?? new Set<EntityId>()
            }
            case 'in': {
                const strs = condition.values.filter((value): value is string => typeof value === 'string')
                if (strs.length === 0) return new Set<EntityId>()
                const result = new Set<EntityId>()
                strs.forEach(v => {
                    const set = this.valueMap.get(v)
                    if (set) set.forEach(id => result.add(id))
                })
                return result
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
        return false
    }
}
