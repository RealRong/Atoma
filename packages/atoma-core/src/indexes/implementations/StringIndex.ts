import { IndexDefinition } from '../../types'
import type { EntityId } from 'atoma-protocol'
import { CandidateResult, IndexStats } from '../types'
import { validateString } from '../validators'
import { IIndex } from '../base/IIndex'

export class StringIndex<T> implements IIndex<T> {
    readonly type = 'string'
    readonly config: IndexDefinition<T>

    private valueMap = new Map<string, Set<EntityId>>()

    constructor(config: IndexDefinition<T>) {
        this.config = config
    }

    add(id: EntityId, value: any): void {
        const str = validateString(value, this.config.field, id)
        const set = this.valueMap.get(str) || new Set<EntityId>()
        set.add(id)
        this.valueMap.set(str, set)
    }

    remove(id: EntityId, value: any): void {
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

    queryCandidates(condition: any): CandidateResult {
        if (condition && typeof condition === 'object' && !Array.isArray(condition) && (condition as any).eq !== undefined) {
            if (typeof (condition as any).eq !== 'string') return { kind: 'empty' }
            const set = this.valueMap.get((condition as any).eq)
            if (!set || set.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids: set, exactness: 'exact' }
        }

        if (condition && typeof condition === 'object' && !Array.isArray(condition) && (condition as any).in) {
            const values = (condition as any).in as any[]
            if (!Array.isArray(values)) return { kind: 'unsupported' }
            const strs = values.filter((v: any) => typeof v === 'string') as string[]
            if (strs.length === 0) return { kind: 'empty' }
            const result = new Set<EntityId>()
            strs.forEach(v => {
                const set = this.valueMap.get(v)
                if (set) set.forEach(id => result.add(id))
            })
            if (result.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids: result, exactness: 'exact' }
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
