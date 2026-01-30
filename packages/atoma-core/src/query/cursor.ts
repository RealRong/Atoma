import type { CursorToken, SortRule } from 'atoma-protocol'

type CursorPayload = { v: 1; sort: SortRule[]; values: unknown[] }

export function encodeCursorToken(sort: SortRule[], values: unknown[]): CursorToken {
    const json = JSON.stringify({ v: 1, sort, values } satisfies CursorPayload)
    return base64UrlEncode(json)
}

export function decodeCursorToken(token: CursorToken): CursorPayload | null {
    try {
        const json = base64UrlDecode(token)
        const parsed = JSON.parse(json) as CursorPayload
        if (!parsed || typeof parsed !== 'object') return null
        if (parsed.v !== 1) return null
        if (!Array.isArray(parsed.sort) || !Array.isArray(parsed.values)) return null
        return parsed
    } catch {
        return null
    }
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
