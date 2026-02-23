import type { CandidateExactness, CandidateResult, FilterExpr } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { intersectAll } from './internal/search'
import type {
    IndexCondition,
    IndexDriver,
    IndexQueryPlan,
    RangeCondition as IndexRangeCondition
} from './types'

type WhereMap = Record<string, IndexCondition>
type SingleCondition = Exclude<IndexCondition, IndexRangeCondition>
type RangeBounds = Omit<IndexRangeCondition, 'op'>
type LowerBound = { op: 'gt' | 'gte'; value: number }
type UpperBound = { op: 'lt' | 'lte'; value: number }

export function planCandidates<T>(args: {
    indexes: Map<string, IndexDriver<T>>
    filter?: FilterExpr
}): { result: CandidateResult; plan: IndexQueryPlan } {
    const where = filterToWhere(args.filter)
    if (!where) return buildUnsupportedResult([], [])

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
        return buildUnsupportedResult(whereFields, perField)
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
            timestamp: Date.now(),
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

function toFieldCondition(filter: FilterExpr): { field: string; condition: IndexCondition } | null {
    switch (filter.op) {
        case 'eq':
            return { field: filter.field, condition: { op: 'eq', value: filter.value } }
        case 'in':
            return { field: filter.field, condition: { op: 'in', values: filter.values } }
        case 'gt':
            return { field: filter.field, condition: { op: 'range', gt: filter.value } }
        case 'gte':
            return { field: filter.field, condition: { op: 'range', gte: filter.value } }
        case 'lt':
            return { field: filter.field, condition: { op: 'range', lt: filter.value } }
        case 'lte':
            return { field: filter.field, condition: { op: 'range', lte: filter.value } }
        case 'startsWith':
            return { field: filter.field, condition: { op: 'startsWith', value: filter.value } }
        case 'endsWith':
            return { field: filter.field, condition: { op: 'endsWith', value: filter.value } }
        case 'contains':
            return { field: filter.field, condition: { op: 'contains', value: filter.value } }
        case 'text':
            return {
                field: filter.field,
                condition: filter.mode === 'fuzzy'
                    ? { op: 'fuzzy', value: { q: filter.query, distance: filter.distance } }
                    : { op: 'match', value: { q: filter.query } }
            }
        default:
            return null
    }
}

function mergeFieldCondition(existing: IndexCondition | undefined, incoming: IndexCondition): IndexCondition | undefined {
    if (!existing) return incoming

    if (existing.op === 'range' || incoming.op === 'range') {
        return existing.op === 'range' && incoming.op === 'range'
            ? mergeRangeCondition(existing, incoming)
            : undefined
    }

    return mergeSingleCondition(existing, incoming)
}

function mergeSingleCondition(existing: SingleCondition, incoming: SingleCondition): SingleCondition | undefined {
    switch (existing.op) {
        case 'in':
            return incoming.op === 'in' && Object.is(existing.values, incoming.values)
                ? existing
                : undefined
        case 'eq':
        case 'startsWith':
        case 'endsWith':
        case 'contains':
        case 'match':
        case 'fuzzy':
            return incoming.op === existing.op && Object.is(existing.value, incoming.value)
                ? existing
                : undefined
    }
}

function mergeRangeCondition(existing: IndexRangeCondition, incoming: IndexRangeCondition): IndexRangeCondition | undefined {
    if (!canMergeRangeValue(existing.gt, incoming.gt)) return undefined
    if (!canMergeRangeValue(existing.gte, incoming.gte)) return undefined
    if (!canMergeRangeValue(existing.lt, incoming.lt)) return undefined
    if (!canMergeRangeValue(existing.lte, incoming.lte)) return undefined

    const normalized = normalizeRangeBounds({
        gt: incoming.gt ?? existing.gt,
        gte: incoming.gte ?? existing.gte,
        lt: incoming.lt ?? existing.lt,
        lte: incoming.lte ?? existing.lte
    })
    return normalized
        ? { op: 'range', ...normalized }
        : undefined
}

function canMergeRangeValue(existing: number | undefined, incoming: number | undefined): boolean {
    if (incoming === undefined || existing === undefined) return true
    return Object.is(existing, incoming)
}

function normalizeRangeBounds(bounds: RangeBounds): RangeBounds | undefined {
    const lower = pickLowerBound(bounds.gt, bounds.gte)
    const upper = pickUpperBound(bounds.lt, bounds.lte)

    if (lower && upper && lower.value > upper.value) {
        return undefined
    }

    const output: RangeBounds = {}
    if (lower) output[lower.op] = lower.value
    if (upper) output[upper.op] = upper.value
    return hasRangeBounds(output) ? output : undefined
}

function hasRangeBounds(bounds: RangeBounds): boolean {
    return bounds.gt !== undefined
        || bounds.gte !== undefined
        || bounds.lt !== undefined
        || bounds.lte !== undefined
}

function pickLowerBound(gt: number | undefined, gte: number | undefined): LowerBound | undefined {
    if (gt === undefined) {
        return gte === undefined ? undefined : { op: 'gte', value: gte }
    }
    if (gte === undefined) return { op: 'gt', value: gt }
    return gt >= gte
        ? { op: 'gt', value: gt }
        : { op: 'gte', value: gte }
}

function pickUpperBound(lt: number | undefined, lte: number | undefined): UpperBound | undefined {
    if (lt === undefined) {
        return lte === undefined ? undefined : { op: 'lte', value: lte }
    }
    if (lte === undefined) return { op: 'lt', value: lt }
    return lt <= lte
        ? { op: 'lt', value: lt }
        : { op: 'lte', value: lte }
}

function buildUnsupportedResult(
    whereFields: string[],
    perField: IndexQueryPlan['perField'] = []
): { result: CandidateResult; plan: IndexQueryPlan } {
    return {
        result: { kind: 'unsupported' },
        plan: {
            timestamp: Date.now(),
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
