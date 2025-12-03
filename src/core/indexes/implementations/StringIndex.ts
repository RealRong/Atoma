import { IndexDefinition, StoreKey } from '../../types'
import { IndexStats } from '../types'
import { validateString } from '../validators'
import { IIndex } from '../base/IIndex'

export class StringIndex<T> implements IIndex<T> {
    readonly type = 'string'
    readonly config: IndexDefinition<T>

    private valueMap = new Map<string, Set<StoreKey>>()

    constructor(config: IndexDefinition<T>) {
        if (config.type !== 'string') {
            throw new Error(`[Atoma Index] Invalid type "${config.type}" for StringIndex.`)
        }
        this.config = config
    }

    add(id: StoreKey, value: any): void {
        const str = validateString(value, this.config.field, id)
        const set = this.valueMap.get(str) || new Set<StoreKey>()
        set.add(id)
        this.valueMap.set(str, set)
    }

    remove(id: StoreKey, value: any): void {
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

    query(condition: any): Set<StoreKey> | undefined {
        if (condition && typeof condition === 'object' && !Array.isArray(condition) && (condition as any).in) {
            const result = new Set<StoreKey>()
            const values = (condition as any).in as any[]
            values.forEach(v => {
                const set = this.valueMap.get(String(v))
                if (set) set.forEach(id => result.add(id))
            })
            return result
        }
        if (condition !== undefined) {
            return this.valueMap.get(String(condition))
        }
        return undefined
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
