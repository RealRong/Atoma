import { IndexDefinition, OrderBy, StoreKey, WhereOperator } from '../types'
import { CandidateExactness, CandidateResult, IndexStats } from './types'
import { intersectAll } from './utils'
import { NumberDateIndex } from './implementations/NumberDateIndex'
import { StringIndex } from './implementations/StringIndex'
import { SubstringIndex } from './implementations/SubstringIndex'
import { TextIndex } from './implementations/TextIndex'
import { IIndex } from './base/IIndex'
import { ISortableIndex } from './base/ISortableIndex'

export class IndexManager<T> {
    private indexes = new Map<string, IIndex<T>>()

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
        if (!where || typeof where === 'function') return { kind: 'unsupported' }

        const candidateSets: Set<StoreKey>[] = []
        let hasUnsupportedCondition = false
        let exactness: CandidateExactness = 'exact'

        Object.entries(where as any).forEach(([field, cond]) => {
            const idx = this.indexes.get(field)
            if (!idx) {
                hasUnsupportedCondition = true
                return
            }
            const res = idx.queryCandidates(cond)
            if (res.kind === 'unsupported') {
                hasUnsupportedCondition = true
                return
            }
            if (res.kind === 'empty') {
                exactness = 'superset'
                candidateSets.length = 0
                candidateSets.push(new Set())
                return
            }
            if (res.exactness === 'superset') exactness = 'superset'
            candidateSets.push(res.ids)
        })

        if (!candidateSets.length) return { kind: 'unsupported' }
        if (hasUnsupportedCondition) exactness = 'superset'

        const ids = intersectAll(candidateSets)
        if (ids.size === 0) return { kind: 'empty' }
        return { kind: 'candidates', ids, exactness }
    }

    getOrderedCandidates(
        orderBy?: OrderBy<T>,
        candidates?: Set<StoreKey>,
        opts?: { limit?: number; offset?: number; applyLimit?: boolean }
    ): StoreKey[] | undefined {
        if (!orderBy || Array.isArray(orderBy)) return undefined
        const idx = this.indexes.get(orderBy.field)
        if (!idx || !this.isSortableIndex(idx)) return undefined
        const limitOpts = opts?.applyLimit ? { limit: opts?.limit, offset: opts?.offset } : undefined
        return idx.getOrderedKeys(orderBy.direction, candidates, limitOpts)
    }

    getStats(field: string): IndexStats | undefined {
        return this.indexes.get(field)?.getStats()
    }

    getAllStats(): Map<string, IndexStats> {
        const stats = new Map<string, IndexStats>()
        this.indexes.forEach((idx, field) => {
            stats.set(field, idx.getStats())
        })
        return stats
    }

    coversWhere(where?: WhereOperator<T>): boolean {
        if (!where) return true
        return Object.keys(where as any).every(field => this.indexes.has(field))
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

    private isSortableIndex(idx: IIndex<T>): idx is ISortableIndex<T> {
        return typeof (idx as any).getOrderedKeys === 'function'
    }
}
