import { IndexDefinition } from '../../types'
import type { EntityId } from '#protocol'
import { CandidateResult, IndexStats } from '../types'
import { binarySearchPrefix, intersectAll } from '../utils'
import { IIndex } from '../base/IIndex'

const normalize = (value: any): string => {
    if (value === undefined || value === null) return ''
    return String(value).toLowerCase()
}

const reverseString = (value: string): string => {
    return value.split('').reverse().join('')
}

const buildNgrams = (value: string, n: number): string[] => {
    if (n <= 0) return []
    if (value.length < n) return []
    const grams = new Set<string>()
    for (let i = 0; i <= value.length - n; i++) {
        grams.add(value.slice(i, i + n))
    }
    return Array.from(grams)
}

export class SubstringIndex<T> implements IIndex<T> {
    readonly type = 'substring'
    readonly config: IndexDefinition<T>

    private ngramSize: number

    private valueMap = new Map<string, Set<EntityId>>()
    private reverseValueMap = new Map<string, Set<EntityId>>()
    private gramMap = new Map<string, Set<EntityId>>()

    private docValue = new Map<EntityId, string>()
    private docGrams = new Map<EntityId, string[]>()

    private sortedValues: string[] | null = null
    private sortedReverseValues: string[] | null = null
    private dirty = false

    constructor(config: IndexDefinition<T>) {
        this.config = config
        this.ngramSize = Math.max(2, Math.min(6, config.options?.ngramSize ?? 3))
    }

    add(id: EntityId, value: any): void {
        const str = normalize(value)
        this.docValue.set(id, str)

        // value -> ids
        const set = this.valueMap.get(str) || new Set<EntityId>()
        set.add(id)
        this.valueMap.set(str, set)

        // reversed value -> ids (for endsWith)
        const reversed = reverseString(str)
        const rset = this.reverseValueMap.get(reversed) || new Set<EntityId>()
        rset.add(id)
        this.reverseValueMap.set(reversed, rset)

        // ngrams for contains
        const grams = buildNgrams(str, this.ngramSize)
        this.docGrams.set(id, grams)
        grams.forEach(g => {
            const gset = this.gramMap.get(g) || new Set<EntityId>()
            gset.add(id)
            this.gramMap.set(g, gset)
        })

        this.sortedValues = null
        this.sortedReverseValues = null
        this.dirty = true
    }

    remove(id: EntityId, _value: any): void {
        const str = this.docValue.get(id)
        if (!str) return

        const set = this.valueMap.get(str)
        if (set) {
            set.delete(id)
            if (set.size === 0) this.valueMap.delete(str)
        }

        const reversed = reverseString(str)
        const rset = this.reverseValueMap.get(reversed)
        if (rset) {
            rset.delete(id)
            if (rset.size === 0) this.reverseValueMap.delete(reversed)
        }

        const grams = this.docGrams.get(id) || []
        grams.forEach(g => {
            const gset = this.gramMap.get(g)
            if (!gset) return
            gset.delete(id)
            if (gset.size === 0) this.gramMap.delete(g)
        })

        this.docValue.delete(id)
        this.docGrams.delete(id)
        this.sortedValues = null
        this.sortedReverseValues = null
        this.dirty = true
    }

    clear(): void {
        this.valueMap.clear()
        this.reverseValueMap.clear()
        this.gramMap.clear()
        this.docValue.clear()
        this.docGrams.clear()
        this.sortedValues = null
        this.sortedReverseValues = null
        this.dirty = true
    }

    queryCandidates(condition: any): CandidateResult {
        if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
            return { kind: 'unsupported' }
        }

        if ((condition as any).startsWith !== undefined) {
            const prefix = normalize((condition as any).startsWith)
            if (!prefix) return { kind: 'unsupported' }
            const result = this.prefixSearch(prefix)
            if (result.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids: result, exactness: 'exact' }
        }

        if ((condition as any).endsWith !== undefined) {
            const suffix = normalize((condition as any).endsWith)
            if (!suffix) return { kind: 'unsupported' }
            const result = this.suffixSearch(suffix)
            if (result.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids: result, exactness: 'exact' }
        }

        if ((condition as any).contains !== undefined) {
            const needle = normalize((condition as any).contains)
            if (!needle) return { kind: 'unsupported' }
            if (needle.length < this.ngramSize) return { kind: 'unsupported' }
            const grams = buildNgrams(needle, this.ngramSize)
            if (!grams.length) return { kind: 'unsupported' }
            const sets: Set<EntityId>[] = []
            for (const gram of grams) {
                const ids = this.gramMap.get(gram)
                if (!ids || ids.size === 0) return { kind: 'empty' }
                sets.push(ids)
            }
            const result = intersectAll(sets)
            if (result.size === 0) return { kind: 'empty' }
            return { kind: 'candidates', ids: result, exactness: 'superset' }
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

    private buildSortedValues(): string[] {
        if (!this.sortedValues || this.dirty) {
            this.sortedValues = Array.from(this.valueMap.keys()).sort()
            this.dirty = false
        }
        return this.sortedValues
    }

    private buildSortedReverseValues(): string[] {
        if (!this.sortedReverseValues || this.dirty) {
            this.sortedReverseValues = Array.from(this.reverseValueMap.keys()).sort()
            this.dirty = false
        }
        return this.sortedReverseValues
    }

    private prefixSearch(prefix: string): Set<EntityId> {
        const sorted = this.buildSortedValues()
        const { start, end } = binarySearchPrefix(sorted, prefix)
        const result = new Set<EntityId>()
        for (let i = start; i < end; i++) {
            const val = sorted[i]
            if (!val.startsWith(prefix)) break
            const ids = this.valueMap.get(val)
            if (ids) ids.forEach(id => result.add(id))
        }
        return result
    }

    private suffixSearch(suffix: string): Set<EntityId> {
        const revPrefix = reverseString(suffix)
        const sorted = this.buildSortedReverseValues()
        const { start, end } = binarySearchPrefix(sorted, revPrefix)
        const result = new Set<EntityId>()
        for (let i = start; i < end; i++) {
            const val = sorted[i]
            if (!val.startsWith(revPrefix)) break
            const ids = this.reverseValueMap.get(val)
            if (ids) ids.forEach(id => result.add(id))
        }
        return result
    }
}
