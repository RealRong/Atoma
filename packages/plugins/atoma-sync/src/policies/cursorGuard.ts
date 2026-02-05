import type { Cursor } from 'atoma-types/protocol'

function parseNumericCursor(value: string): bigint | null {
    if (!value.match(/^(0|[1-9][0-9]*)$/)) return null
    try {
        return BigInt(value)
    } catch {
        return null
    }
}

export function defaultCompareCursor(current: Cursor, next: Cursor): number {
    const a = parseNumericCursor(String(current))
    const b = parseNumericCursor(String(next))
    if (a !== null && b !== null) {
        if (a === b) return 0
        return a < b ? -1 : 1
    }
    if (current === next) return 0
    return -1
}