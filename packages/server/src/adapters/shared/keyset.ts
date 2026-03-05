import type { CursorToken, SortRule } from '@atoma-js/types/protocol'
import {
    decodeCursorToken as decodeSharedCursorToken,
    encodeCursorToken as encodeSharedCursorToken
} from '@atoma-js/shared'

type CursorPayload = { v: number; sort: SortRule[]; values: any[] }

export function ensureStableOrderBy(
    sort: SortRule[] | undefined,
    options: { idField: string; defaultSort?: SortRule[] }
): SortRule[] {
    const base = (sort && sort.length)
        ? sort
        : (options.defaultSort && options.defaultSort.length)
            ? options.defaultSort
            : [{ field: options.idField, dir: 'asc' as const }]

    const hasId = base.some(r => r.field === options.idField)
    return hasId ? base : [...base, { field: options.idField, dir: 'asc' as const }]
}

export function reverseOrderBy(sort: SortRule[]): SortRule[] {
    return sort.map(r => ({
        field: r.field,
        dir: r.dir === 'asc' ? 'desc' : 'asc'
    }))
}

export function encodeCursorToken(values: any[], sort: SortRule[]): CursorToken {
    return encodeSharedCursorToken(sort, values)
}

export function decodeCursorToken(token: CursorToken): CursorPayload {
    const parsed = decodeSharedCursorToken(token)
    if (!parsed || !Array.isArray(parsed.values) || !Array.isArray(parsed.sort)) {
        throw new Error('Invalid cursor token')
    }
    if (parsed.values.length < parsed.sort.length) {
        throw new Error('Invalid cursor token')
    }
    return {
        v: 1,
        sort: parsed.sort.map(rule => ({ field: rule.field, dir: rule.dir })),
        values: parsed.values
    }
}

export function getCursorValuesFromRow(row: any, sort: SortRule[]): any[] {
    return sort.map(r => (row as any)?.[r.field])
}

export function isSameSort(a: SortRule[], b: SortRule[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        if (a[i].field !== b[i].field || a[i].dir !== b[i].dir) {
            return false
        }
    }
    return true
}

export function readNullCursorField(values: unknown[], sort: SortRule[]): string | undefined {
    const len = Math.min(values.length, sort.length)
    for (let i = 0; i < len; i += 1) {
        const value = values[i]
        if (value === null || value === undefined) {
            return sort[i].field
        }
    }
    return undefined
}

export function compareOpForAfter(dir: SortRule['dir']) {
    return dir === 'asc' ? 'gt' : 'lt'
}
