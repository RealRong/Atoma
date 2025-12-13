import type { CursorToken, OrderByRule } from '../../types'

type CursorPayload = { v: any[] }

export function ensureStableOrderBy(
    orderBy: OrderByRule[] | undefined,
    options: { idField: string; defaultOrderBy?: OrderByRule[] }
): OrderByRule[] {
    const base = (orderBy && orderBy.length)
        ? orderBy
        : (options.defaultOrderBy && options.defaultOrderBy.length)
            ? options.defaultOrderBy
            : [{ field: options.idField, direction: 'asc' as const }]

    // 追加 idField 作为 tie-breaker，确保排序稳定且唯一
    const hasId = base.some(r => r.field === options.idField)
    return hasId ? base : [...base, { field: options.idField, direction: 'asc' }]
}

export function reverseOrderBy(orderBy: OrderByRule[]): OrderByRule[] {
    return orderBy.map(r => ({
        field: r.field,
        direction: r.direction === 'asc' ? 'desc' : 'asc'
    }))
}

export function encodeCursorToken(values: any[]): CursorToken {
    const json = JSON.stringify({ v: values } satisfies CursorPayload)
    return base64UrlEncode(json)
}

export function decodeCursorToken(token: CursorToken): any[] {
    const json = base64UrlDecode(token)
    const parsed = JSON.parse(json) as CursorPayload
    if (!parsed || !Array.isArray(parsed.v)) {
        throw new Error('Invalid cursor token')
    }
    return parsed.v
}

export function getCursorValuesFromRow(row: any, orderBy: OrderByRule[]): any[] {
    return orderBy.map(r => (row as any)?.[r.field])
}

export function compareOpForAfter(direction: OrderByRule['direction']) {
    return direction === 'asc' ? 'gt' : 'lt'
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

