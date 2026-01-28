import type { CursorToken, SortRule } from '../ports'

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
    const json = JSON.stringify({ v: 1, sort, values } satisfies CursorPayload)
    return base64UrlEncode(json)
}

export function decodeCursorToken(token: CursorToken): any[] {
    const json = base64UrlDecode(token)
    const parsed = JSON.parse(json) as CursorPayload
    if (!parsed || !Array.isArray(parsed.values)) {
        throw new Error('Invalid cursor token')
    }
    return parsed.values
}

export function getCursorValuesFromRow(row: any, sort: SortRule[]): any[] {
    return sort.map(r => (row as any)?.[r.field])
}

export function compareOpForAfter(dir: SortRule['dir']) {
    return dir === 'asc' ? 'gt' : 'lt'
}

function base64UrlEncode(input: string) {
    const base64 = (typeof Buffer !== 'undefined')
        ? Buffer.from(input, 'utf8').toString('base64')
        : btoa(unescape(encodeURIComponent(input)))
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(input: string) {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/')
    const padLen = (4 - (padded.length % 4)) % 4
    const base64 = padded + '='.repeat(padLen)
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(base64, 'base64').toString('utf8')
    }
    return decodeURIComponent(escape(atob(base64)))
}
