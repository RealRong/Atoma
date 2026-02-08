import type { CandidateExactness, CandidateResult, FilterExpr } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { intersectAll } from './internal/search'
import type { IndexDriver, IndexQueryPlan } from './types'

type WhereCondition = {
    eq?: unknown
    in?: unknown[]
    gt?: unknown
    gte?: unknown
    lt?: unknown
    lte?: unknown
    startsWith?: unknown
    endsWith?: unknown
    contains?: unknown
    match?: { q: unknown }
    fuzzy?: { q: unknown; distance?: unknown }
}

type WhereMap = Record<string, WhereCondition>

export function planCandidates<T>(args: {
    indexes: Map<string, IndexDriver<T>>
    filter?: FilterExpr
}): { result: CandidateResult; plan: IndexQueryPlan } {
    const where = filterToWhere(args.filter)
    if (!where) {
        return {
            result: { kind: 'unsupported' },
            plan: {
                timestamp: Date.now(),
                whereFields: [],
                perField: [],
                result: { kind: 'unsupported' }
            }
        }
    }

    const candidateSets: Set<EntityId>[] = []
    let hasUnsupportedCondition = false
    let exactness: CandidateExactness = 'exact'
    const perField: IndexQueryPlan['perField'] = []

    Object.entries(where).forEach(([field, condition]) => {
        const index = args.indexes.get(field)
        if (!index) {
            hasUnsupportedCondition = true
            perField.push({ field, status: 'no_index' })
            return
        }

        const candidate = index.queryCandidates(condition)
        if (candidate.kind === 'unsupported') {
            hasUnsupportedCondition = true
            perField.push({ field, status: 'unsupported' })
            return
        }

        if (candidate.kind === 'empty') {
            exactness = 'superset'
            candidateSets.length = 0
            candidateSets.push(new Set())
            perField.push({ field, status: 'empty' })
            return
        }

        if (candidate.exactness === 'superset') exactness = 'superset'
        candidateSets.push(candidate.ids)
        perField.push({
            field,
            status: 'candidates',
            exactness: candidate.exactness,
            candidates: candidate.ids.size
        })
    })

    if (!candidateSets.length) {
        return {
            result: { kind: 'unsupported' },
            plan: {
                timestamp: Date.now(),
                whereFields: Object.keys(where),
                perField,
                result: { kind: 'unsupported' }
            }
        }
    }

    if (hasUnsupportedCondition) exactness = 'superset'

    const ids = intersectAll(candidateSets)
    const result: CandidateResult = ids.size === 0
        ? { kind: 'empty' }
        : { kind: 'candidates', ids, exactness }

    return {
        result,
        plan: {
            timestamp: Date.now(),
            whereFields: Object.keys(where),
            perField,
            result: result.kind === 'candidates'
                ? { kind: 'candidates', exactness: result.exactness, candidates: result.ids.size }
                : { kind: result.kind }
        }
    }
}

function filterToWhere(filter?: FilterExpr): WhereMap | undefined {
    if (!filter) return undefined

    if (filter.op === 'and' && Array.isArray(filter.args)) {
        const output: WhereMap = {}

        for (const child of filter.args) {
            const partial = filterToWhere(child)
            if (!partial) return undefined

            for (const [field, incoming] of Object.entries(partial)) {
                const existing = output[field]
                const merged = mergeFieldCondition(existing, incoming)
                if (!merged) return undefined
                output[field] = merged
            }
        }

        return Object.keys(output).length ? output : undefined
    }

    switch (filter.op) {
        case 'eq':
            return { [filter.field]: { eq: filter.value } }
        case 'in':
            return { [filter.field]: { in: filter.values } }
        case 'gt':
            return { [filter.field]: { gt: filter.value } }
        case 'gte':
            return { [filter.field]: { gte: filter.value } }
        case 'lt':
            return { [filter.field]: { lt: filter.value } }
        case 'lte':
            return { [filter.field]: { lte: filter.value } }
        case 'startsWith':
            return { [filter.field]: { startsWith: filter.value } }
        case 'endsWith':
            return { [filter.field]: { endsWith: filter.value } }
        case 'contains':
            return { [filter.field]: { contains: filter.value } }
        case 'text':
            if (filter.mode === 'fuzzy') {
                return { [filter.field]: { fuzzy: { q: filter.query, distance: filter.distance } } }
            }
            return { [filter.field]: { match: { q: filter.query } } }
        default:
            return undefined
    }
}

function assignWhereCondition(target: WhereCondition, key: keyof WhereCondition, value: unknown) {
    const targetRecord = target as Record<string, unknown>
    targetRecord[key] = value
}

function mergeFieldCondition(existing: WhereCondition | undefined, incoming: WhereCondition): WhereCondition | undefined {
    if (!existing) return incoming

    const merged: WhereCondition = { ...existing }

    for (const [key, value] of Object.entries(incoming) as Array<[keyof WhereCondition, unknown]>) {
        const current = merged[key]
        if (current !== undefined) {
            if (!Object.is(current, value)) return undefined
            continue
        }
        assignWhereCondition(merged, key, value)
    }

    const keys = Object.keys(merged)
    if (keys.length <= 1) return merged

    const hasEq = merged.eq !== undefined
    const hasIn = merged.in !== undefined
    if (hasEq || hasIn) return undefined

    if (merged.match !== undefined || merged.fuzzy !== undefined) {
        return keys.length === 1 ? merged : undefined
    }

    if (merged.startsWith !== undefined || merged.endsWith !== undefined || merged.contains !== undefined) {
        const allowed = ['startsWith', 'endsWith', 'contains']
        return keys.every(key => allowed.includes(key)) && keys.length === 1
            ? merged
            : undefined
    }

    return normalizeRangeCondition(merged)
}

function normalizeRangeCondition(condition: WhereCondition): WhereCondition | undefined {
    const output: WhereCondition = { ...condition }

    const lower = pickLowerBound(condition.gt, condition.gte)
    if (!lower) return undefined
    delete output.gt
    delete output.gte
    if (lower.op) output[lower.op] = lower.value

    const upper = pickUpperBound(condition.lt, condition.lte)
    if (!upper) return undefined
    delete output.lt
    delete output.lte
    if (upper.op) output[upper.op] = upper.value

    if (lower.op && upper.op) {
        const cmp = compareComparable(lower.value, upper.value)
        if (cmp !== null && cmp > 0) {
            return undefined
        }
    }

    return output
}

function pickLowerBound(gt: unknown, gte: unknown): { op?: 'gt' | 'gte'; value?: unknown } | null {
    if (gt === undefined && gte === undefined) return {}
    if (gt === undefined) return { op: 'gte', value: gte }
    if (gte === undefined) return { op: 'gt', value: gt }

    const cmp = compareComparable(gt, gte)
    if (cmp === null) return null
    if (cmp > 0) return { op: 'gt', value: gt }
    if (cmp < 0) return { op: 'gte', value: gte }
    return { op: 'gt', value: gt }
}

function pickUpperBound(lt: unknown, lte: unknown): { op?: 'lt' | 'lte'; value?: unknown } | null {
    if (lt === undefined && lte === undefined) return {}
    if (lt === undefined) return { op: 'lte', value: lte }
    if (lte === undefined) return { op: 'lt', value: lt }

    const cmp = compareComparable(lt, lte)
    if (cmp === null) return null
    if (cmp < 0) return { op: 'lt', value: lt }
    if (cmp > 0) return { op: 'lte', value: lte }
    return { op: 'lt', value: lt }
}

function compareComparable(left: unknown, right: unknown): number | null {
    if (Object.is(left, right)) return 0
    if (left === undefined || right === undefined) return null

    if (typeof left === 'number' && typeof right === 'number') {
        if (left > right) return 1
        if (left < right) return -1
        return 0
    }

    if (typeof left === 'string' && typeof right === 'string') {
        if (left > right) return 1
        if (left < right) return -1
        return 0
    }

    if (left instanceof Date && right instanceof Date) {
        const l = left.getTime()
        const r = right.getTime()
        if (l > r) return 1
        if (l < r) return -1
        return 0
    }

    return null
}
