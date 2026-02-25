import type { FilterExpr, Hits } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { intersectAll } from '../../shared/search'
import { mergeRange } from './range'
import type {
    Condition,
    Index,
    RangeCondition as IndexRangeCondition
} from '../types'

type WhereMap = Record<string, Condition>
type SingleCondition = Exclude<Condition, IndexRangeCondition>

export function plan<T>({
    indexes,
    filter
}: {
    indexes: Map<string, Index<T>>
    filter?: FilterExpr
}): Hits {
    const where = filterToWhere(filter)
    if (!where) {
        return { kind: 'scan' }
    }

    const hitSets: ReadonlySet<EntityId>[] = []
    for (const field in where) {
        if (!Object.prototype.hasOwnProperty.call(where, field)) continue
        const condition = where[field]
        const index = indexes.get(field)
        if (!index) continue

        const hits = index.query(condition)
        if (!hits) continue
        if (!hits.size) {
            return {
                kind: 'hits',
                ids: new Set<EntityId>()
            }
        }
        hitSets.push(hits)
    }

    if (!hitSets.length) {
        return { kind: 'scan' }
    }

    return {
        kind: 'hits',
        ids: hitSets.length === 1
            ? hitSets[0]
            : intersectAll(hitSets.map((item) => new Set(item)))
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

function toFieldCondition(filter: FilterExpr): { field: string; condition: Condition } | null {
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

function mergeFieldCondition(existing: Condition | undefined, incoming: Condition): Condition | undefined {
    if (!existing) return incoming

    if (existing.op === 'range' || incoming.op === 'range') {
        return existing.op === 'range' && incoming.op === 'range'
            ? mergeRange(existing, incoming)
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
