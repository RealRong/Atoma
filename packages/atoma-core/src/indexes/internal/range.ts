import type { RangeCondition as IndexRangeCondition } from '../types'

type RangeBounds = Omit<IndexRangeCondition, 'op'>
type LowerBound = { op: 'gt' | 'gte'; value: number }
type UpperBound = { op: 'lt' | 'lte'; value: number }

export function mergeRange(
    existing: IndexRangeCondition,
    incoming: IndexRangeCondition
): IndexRangeCondition | undefined {
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
