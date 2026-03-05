export type CursorSortRule = {
    field: string
    dir: 'asc' | 'desc'
}

export type CursorPayload = {
    v: 1
    sort: CursorSortRule[]
    values: unknown[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isSortRules = (value: unknown): value is CursorSortRule[] => {
    if (!Array.isArray(value)) return false
    return value.every(rule => {
        if (!isRecord(rule)) return false
        const field = rule.field
        const dir = rule.dir
        return typeof field === 'string' && !!field && (dir === 'asc' || dir === 'desc')
    })
}

export function encodeCursorToken(sort: CursorSortRule[], values: unknown[]): string {
    const json = JSON.stringify({
        v: 1,
        sort,
        values
    } satisfies CursorPayload)
    return base64UrlEncode(json)
}

export function decodeCursorToken(token: string): CursorPayload | null {
    try {
        const json = base64UrlDecode(token)
        const parsed = JSON.parse(json) as unknown
        if (!isRecord(parsed)) return null
        if (parsed.v !== 1) return null
        if (!isSortRules(parsed.sort)) return null
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

function base64UrlEncode(input: string): string {
    const base64 = (typeof Buffer !== 'undefined')
        ? Buffer.from(input, 'utf8').toString('base64')
        : btoa(unescape(encodeURIComponent(input)))
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(input: string): string {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/')
    const padLen = (4 - (padded.length % 4)) % 4
    const base64 = padded + '='.repeat(padLen)
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(base64, 'base64').toString('utf8')
    }
    return decodeURIComponent(escape(atob(base64)))
}
