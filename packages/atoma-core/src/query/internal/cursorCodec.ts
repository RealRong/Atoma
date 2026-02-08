import type { CursorToken, SortRule } from 'atoma-types/core'

type CursorPayload = { v: 1; sort: SortRule[]; values: unknown[] }

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function encodeCursorToken(sort: SortRule[], values: unknown[]): CursorToken {
    const json = JSON.stringify({ v: 1, sort, values } satisfies CursorPayload)
    return base64UrlEncode(json)
}

export function decodeCursorToken(token: CursorToken): CursorPayload | null {
    try {
        const json = base64UrlDecode(token)
        const parsed = JSON.parse(json) as unknown
        if (!isRecord(parsed)) return null
        if (parsed.v !== 1) return null
        if (!isValidSortRules(parsed.sort)) return null
        if (!Array.isArray(parsed.values)) return null

        return {
            v: 1,
            sort: parsed.sort,
            values: parsed.values
        }
    } catch {
        return null
    }
}

function isValidSortRules(value: unknown): value is SortRule[] {
    if (!Array.isArray(value)) return false

    return value.every((rule) => {
        if (!isRecord(rule)) return false

        const field = rule.field
        const dir = rule.dir
        if (typeof field !== 'string' || !field) return false

        return dir === 'asc' || dir === 'desc'
    })
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
