import type { CursorStore } from './types'
import type { VNextCursor } from '#protocol'

type CompareFn = (current: VNextCursor, next: VNextCursor) => number

function parseNumericCursor(value: string): bigint | null {
    if (!value.match(/^(0|[1-9][0-9]*)$/)) return null
    try {
        return BigInt(value)
    } catch {
        return null
    }
}

export function defaultCompareCursor(current: VNextCursor, next: VNextCursor): number {
    const a = parseNumericCursor(String(current))
    const b = parseNumericCursor(String(next))
    if (a !== null && b !== null) {
        if (a === b) return 0
        return a < b ? -1 : 1
    }
    if (current === next) return 0
    return -1
}

export class MemoryCursorStore implements CursorStore {
    private cursor: VNextCursor | undefined

    constructor(initial?: VNextCursor, private readonly compare: CompareFn = defaultCompareCursor) {
        this.cursor = initial
    }

    get() {
        return this.cursor
    }

    set(next: VNextCursor) {
        if (this.cursor === undefined) {
            this.cursor = next
            return true
        }
        const cmp = this.compare(this.cursor, next)
        if (cmp < 0) {
            this.cursor = next
            return true
        }
        return false
    }
}
