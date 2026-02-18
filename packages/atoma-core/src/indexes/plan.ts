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

const STRING_LIKE_KEYS: Array<keyof WhereCondition> = ['startsWith', 'endsWith', 'contains']
const WHERE_CONDITION_KEYS: Array<keyof WhereCondition> = [
    'eq',
    'in',
    'gt',
    'gte',
    'lt',
    'lte',
    'startsWith',
    'endsWith',
    'contains',
    'match',
    'fuzzy'
]

const WHERE_KEY_BY_OP = {
    eq: 'eq',
    in: 'in',
    gt: 'gt',
    gte: 'gte',
    lt: 'lt',
    lte: 'lte',
    startsWith: 'startsWith',
    endsWith: 'endsWith',
    contains: 'contains'
} as const

type WhereSimpleOp = keyof typeof WHERE_KEY_BY_OP
type WhereSimpleFilter = Extract<FilterExpr, { op: WhereSimpleOp }>

function isWhereSimpleFilter(filter: FilterExpr): filter is WhereSimpleFilter {
    return filter.op in WHERE_KEY_BY_OP
}

export function planCandidates<T>(args: {
    indexes: Map<string, IndexDriver<T>>
    filter?: FilterExpr
    now?: () => number
}): { result: CandidateResult; plan: IndexQueryPlan } {
    const now = args.now ?? Date.now
    const where = filterToWhere(args.filter)
    if (!where) return buildUnsupportedResult([], [], now)

    const candidateSets: Set<EntityId>[] = []
    const whereFields: string[] = []
    let hasUnsupportedCondition = false
    let hasEmptyCondition = false
    let exactness: CandidateExactness = 'exact'
    const perField: IndexQueryPlan['perField'] = []

    for (const field in where) {
        if (!Object.prototype.hasOwnProperty.call(where, field)) continue
        const condition = where[field]
        whereFields.push(field)

        const index = args.indexes.get(field)
        if (!index) {
            hasUnsupportedCondition = true
            perField.push({ field, status: 'no_index' })
            continue
        }

        const candidate = index.queryCandidates(condition)
        if (candidate.kind === 'unsupported') {
            hasUnsupportedCondition = true
            perField.push({ field, status: 'unsupported' })
            continue
        }

        if (candidate.kind === 'empty') {
            hasEmptyCondition = true
            exactness = 'superset'
            perField.push({ field, status: 'empty' })
            continue
        }

        if (candidate.exactness === 'superset') exactness = 'superset'
        if (!hasEmptyCondition) {
            candidateSets.push(candidate.ids)
        }
        perField.push({
            field,
            status: 'candidates',
            exactness: candidate.exactness,
            candidates: candidate.ids.size
        })
    }

    if (!candidateSets.length && !hasEmptyCondition) {
        return buildUnsupportedResult(whereFields, perField, now)
    }

    if (hasUnsupportedCondition) exactness = 'superset'

    const result = hasEmptyCondition
        ? ({ kind: 'empty' } as CandidateResult)
        : toCandidateResult(
            candidateSets.length === 1 ? candidateSets[0] : intersectAll(candidateSets),
            exactness
        )

    return {
        result,
        plan: {
            timestamp: now(),
            whereFields,
            perField,
            result: toPlanResult(result)
        }
    }
}

function filterToWhere(filter?: FilterExpr): WhereMap | undefined {
    if (!filter) return undefined

    const output: WhereMap = {}
    return collectWhereConditions(filter, output) && Object.keys(output).length
        ? output
        : undefined
}

function collectWhereConditions(filter: FilterExpr, output: WhereMap): boolean {
    if (filter.op === 'and' && Array.isArray(filter.args)) {
        for (const child of filter.args) {
            if (!collectWhereConditions(child, output)) {
                return false
            }
        }
        return true
    }

    const fieldCondition = toFieldCondition(filter)
    if (!fieldCondition) return false

    const existing = output[fieldCondition.field]
    const merged = mergeFieldCondition(existing, fieldCondition.condition)
    if (!merged) return false
    output[fieldCondition.field] = merged
    return true
}

function toFieldCondition(filter: FilterExpr): { field: string; condition: WhereCondition } | null {
    if (isWhereSimpleFilter(filter)) {
        const key = WHERE_KEY_BY_OP[filter.op]
        return {
            field: filter.field,
            condition: {
                [key]: filter.op === 'in' ? filter.values : filter.value
            } as WhereCondition
        }
    }

    if (filter.op === 'text') {
        return {
            field: filter.field,
            condition: filter.mode === 'fuzzy'
                ? { fuzzy: { q: filter.query, distance: filter.distance } }
                : { match: { q: filter.query } }
        }
    }

    return null
}

function mergeFieldCondition(existing: WhereCondition | undefined, incoming: WhereCondition): WhereCondition | undefined {
    if (!existing) return incoming

    const merged: WhereCondition = { ...existing }

    for (const key of WHERE_CONDITION_KEYS) {
        const value = incoming[key]
        if (value === undefined) continue
        const current = merged[key]
        if (current !== undefined) {
            if (!Object.is(current, value)) return undefined
            continue
        }
        ;(merged as Record<string, unknown>)[key] = value
    }

    const keys = Object.keys(merged)
    if (keys.length <= 1) return merged

    if (merged.eq !== undefined || merged.in !== undefined) return undefined

    if (merged.match !== undefined || merged.fuzzy !== undefined) {
        return keys.length === 1 ? merged : undefined
    }

    if (merged.startsWith !== undefined || merged.endsWith !== undefined || merged.contains !== undefined) {
        return keys.every(key => STRING_LIKE_KEYS.includes(key as keyof WhereCondition)) && keys.length === 1
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

function buildUnsupportedResult(
    whereFields: string[],
    perField: IndexQueryPlan['perField'] = [],
    now: () => number = Date.now
): { result: CandidateResult; plan: IndexQueryPlan } {
    return {
        result: { kind: 'unsupported' },
        plan: {
            timestamp: now(),
            whereFields,
            perField,
            result: { kind: 'unsupported' }
        }
    }
}

function toCandidateResult(ids: Set<EntityId>, exactness: CandidateExactness): CandidateResult {
    return ids.size === 0
        ? { kind: 'empty' }
        : { kind: 'candidates', ids, exactness }
}

function toPlanResult(result: CandidateResult): IndexQueryPlan['result'] {
    return result.kind === 'candidates'
        ? { kind: 'candidates', exactness: result.exactness, candidates: result.ids.size }
        : { kind: result.kind }
}
