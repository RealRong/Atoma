import type { IndexDefinition } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { CandidateResult, IndexStats } from 'atoma-types/core'
import { validateString } from '../validators'
import { IIndex } from '../base/IIndex'

export class StringIndex<T> implements IIndex<T> {
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

    queryCandidates(condition: unknown): CandidateResult {
        if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
            const conditionRecord = condition as { eq?: unknown; in?: unknown[] }
            if (conditionRecord.eq !== undefined) {
            if (typeof conditionRecord.eq !== 'string') return { kind: 'empty' }
            const set = this.valueMap.get(conditionRecord.eq)
            if (!set || set.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids: set, exactness: 'exact' }
        }
            if (conditionRecord.in !== undefined) {
            const values = conditionRecord.in
            if (!Array.isArray(values)) return { kind: 'unsupported' }
            const strs = values.filter((value): value is string => typeof value === 'string')
            if (strs.length === 0) return { kind: 'empty' }
            const result = new Set<EntityId>()
            strs.forEach(v => {
                const set = this.valueMap.get(v)
                if (set) set.forEach(id => result.add(id))
            })
            if (result.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids: result, exactness: 'exact' }
            }
        }

        // Primitive equality
        if (typeof condition === 'string') {
            const set = this.valueMap.get(condition)
            if (!set || set.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids: set, exactness: 'exact' }
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
        return false
    }
}