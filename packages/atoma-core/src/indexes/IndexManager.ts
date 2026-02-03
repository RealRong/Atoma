import type { IndexDefinition } from 'atoma-types/core'
import type { FilterExpr } from 'atoma-types/protocol'
import type { EntityId } from 'atoma-types/protocol'
import type { CandidateExactness, CandidateResult, IndexStats } from 'atoma-types/core'
import { intersectAll } from './utils'
import { NumberDateIndex } from './implementations/NumberDateIndex'
import { StringIndex } from './implementations/StringIndex'
import { SubstringIndex } from './implementations/SubstringIndex'
import { TextIndex } from './implementations/TextIndex'
import { IIndex } from './base/IIndex'
import { zod } from 'atoma-shared'

const { parseOrThrow, z } = zod

const indexDefinitionSchema = z.object({
    field: z.string().trim().min(1),
    type: z.enum(['number', 'date', 'string', 'substring', 'text']),
    options: z.any().optional()
}).loose()

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
        const id = (item as any).id as EntityId
        this.indexes.forEach(idx => {
            const value = (item as any)[idx.config.field]
            if (value !== undefined && value !== null) {
                idx.add(id, value)
            }
        })
    }

    remove(item?: T): void {
        if (!item) return
        const id = (item as any).id as EntityId
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

    collectCandidates(filter?: FilterExpr): CandidateResult {
        const where = filterToWhere(filter)
        if (!where) {
            this.lastQueryPlan = {
                timestamp: Date.now(),
                whereFields: [],
                perField: [],
                result: { kind: 'unsupported' }
            }
            return { kind: 'unsupported' }
        }

        const candidateSets: Set<EntityId>[] = []
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
        def = parseOrThrow(indexDefinitionSchema, def, { prefix: '[Atoma Index] ' }) as any

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
        }
    }
}

function filterToWhere(filter?: FilterExpr): Record<string, any> | undefined {
    if (!filter) return undefined
    const op = (filter as any).op

    if (op === 'and' && Array.isArray((filter as any).args)) {
        const out: Record<string, any> = {}
        for (const child of (filter as any).args as any[]) {
            const partial = filterToWhere(child as any)
            if (!partial) return undefined
            for (const [k, v] of Object.entries(partial)) {
                if (Object.prototype.hasOwnProperty.call(out, k)) return undefined
                out[k] = v
            }
        }
        return Object.keys(out).length ? out : undefined
    }

    if (op === 'eq') return { [(filter as any).field]: { eq: (filter as any).value } }
    if (op === 'in') return { [(filter as any).field]: { in: (filter as any).values } }
    if (op === 'gt') return { [(filter as any).field]: { gt: (filter as any).value } }
    if (op === 'gte') return { [(filter as any).field]: { gte: (filter as any).value } }
    if (op === 'lt') return { [(filter as any).field]: { lt: (filter as any).value } }
    if (op === 'lte') return { [(filter as any).field]: { lte: (filter as any).value } }
    if (op === 'startsWith') return { [(filter as any).field]: { startsWith: (filter as any).value } }
    if (op === 'endsWith') return { [(filter as any).field]: { endsWith: (filter as any).value } }
    if (op === 'contains') return { [(filter as any).field]: { contains: (filter as any).value } }
    if (op === 'text') {
        const mode = (filter as any).mode
        const query = (filter as any).query
        if (mode === 'fuzzy') {
            return { [(filter as any).field]: { fuzzy: { q: query, distance: (filter as any).distance } } }
        }
        return { [(filter as any).field]: { match: { q: query } } }
    }

    return undefined
}