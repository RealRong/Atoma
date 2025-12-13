import { IndexDefinition, StoreKey, WhereOperator } from '../types'
import { CandidateExactness, CandidateResult, IndexStats } from './types'
import { intersectAll } from './utils'
import { NumberDateIndex } from './implementations/NumberDateIndex'
import { StringIndex } from './implementations/StringIndex'
import { SubstringIndex } from './implementations/SubstringIndex'
import { TextIndex } from './implementations/TextIndex'
import { IIndex } from './base/IIndex'

export class IndexManager<T> {
    private indexes = new Map<string, IIndex<T>>()
    private lastQueryPlan:
        | undefined
        | {
            timestamp: number
            whereFields: string[]
            perField: Array<{
                field: string
                status: 'no_index' | 'unsupported' | 'empty' | 'candidates'
                exactness?: CandidateExactness
                candidates?: number
            }>
            result: { kind: CandidateResult['kind']; exactness?: CandidateExactness; candidates?: number }
        }

    constructor(defs: Array<IndexDefinition<T>>) {
        const seen = new Set<string>()
        defs.forEach(def => {
            if (seen.has(def.field)) {
                throw new Error(`[Atoma Index] Duplicate index field "${def.field}".`)
            }
            seen.add(def.field)
            this.indexes.set(def.field, this.createIndex(def))
        })
    }

    add(item: T): void {
        const id = (item as any).id as StoreKey
        this.indexes.forEach(idx => {
            const value = (item as any)[idx.config.field]
            if (value !== undefined && value !== null) {
                idx.add(id, value)
            }
        })
    }

    remove(item?: T): void {
        if (!item) return
        const id = (item as any).id as StoreKey
        this.indexes.forEach(idx => {
            const value = (item as any)[idx.config.field]
            if (value !== undefined && value !== null) {
                idx.remove(id, value)
            }
        })
    }

    rebuild(items: Iterable<T>): void {
        const source = Array.isArray(items) ? items : Array.from(items)
        this.indexes.forEach(idx => idx.clear())
        source.forEach(item => this.add(item))
    }

    collectCandidates(where?: WhereOperator<T>): CandidateResult {
        if (!where || typeof where === 'function') {
            this.lastQueryPlan = {
                timestamp: Date.now(),
                whereFields: [],
                perField: [],
                result: { kind: 'unsupported' }
            }
            return { kind: 'unsupported' }
        }

        const candidateSets: Set<StoreKey>[] = []
        let hasUnsupportedCondition = false
        let exactness: CandidateExactness = 'exact'
        const planPerField: Array<{
            field: string
            status: 'no_index' | 'unsupported' | 'empty' | 'candidates'
            exactness?: CandidateExactness
            candidates?: number
        }> = []

        Object.entries(where as any).forEach(([field, cond]) => {
            const idx = this.indexes.get(field)
            if (!idx) {
                hasUnsupportedCondition = true
                planPerField.push({ field, status: 'no_index' })
                return
            }
            const res = idx.queryCandidates(cond)
            if (res.kind === 'unsupported') {
                hasUnsupportedCondition = true
                planPerField.push({ field, status: 'unsupported' })
                return
            }
            if (res.kind === 'empty') {
                exactness = 'superset'
                candidateSets.length = 0
                candidateSets.push(new Set())
                planPerField.push({ field, status: 'empty' })
                return
            }
            if (res.exactness === 'superset') exactness = 'superset'
            candidateSets.push(res.ids)
            planPerField.push({ field, status: 'candidates', exactness: res.exactness, candidates: res.ids.size })
        })

        if (!candidateSets.length) {
            this.lastQueryPlan = {
                timestamp: Date.now(),
                whereFields: Object.keys(where as any),
                perField: planPerField,
                result: { kind: 'unsupported' }
            }
            return { kind: 'unsupported' }
        }
        if (hasUnsupportedCondition) exactness = 'superset'

        const ids = intersectAll(candidateSets)
        const result: CandidateResult =
            ids.size === 0
                ? { kind: 'empty' }
                : { kind: 'candidates', ids, exactness }

        this.lastQueryPlan = {
            timestamp: Date.now(),
            whereFields: Object.keys(where as any),
            perField: planPerField,
            result:
                result.kind === 'candidates'
                    ? { kind: 'candidates', exactness: result.exactness, candidates: result.ids.size }
                    : { kind: result.kind }
        }

        return result
    }

    getStats(field: string): IndexStats | undefined {
        return this.indexes.get(field)?.getStats()
    }

    getIndexSnapshots(): Array<{ field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats> {
        const list: Array<{ field: string; type: IndexDefinition<T>['type']; dirty: boolean } & IndexStats> = []
        this.indexes.forEach((idx, field) => {
            const stats = idx.getStats()
            list.push({
                field,
                type: (idx.config as any).type,
                dirty: idx.isDirty(),
                ...stats
            })
        })
        return list
    }

    getLastQueryPlan() {
        return this.lastQueryPlan
    }

    private createIndex(def: IndexDefinition<T>): IIndex<T> {
        switch (def.type) {
            case 'number':
            case 'date':
                return new NumberDateIndex<T>(def as any)
            case 'string':
                return new StringIndex<T>(def)
            case 'substring':
                return new SubstringIndex<T>(def)
            case 'text':
                return new TextIndex<T>(def)
            default:
                throw new Error(`[Atoma Index] Unsupported index type "${(def as any).type}" for field "${def.field}".`)
        }
    }
}
