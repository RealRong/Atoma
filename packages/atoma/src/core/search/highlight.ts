import type { HighlightRange } from './types'

export const indicesToRanges = (indices: number[]): HighlightRange[] => {
    if (indices.length === 0) return []
    const sorted = [...indices].sort((a, b) => a - b)
    const ranges: HighlightRange[] = []
    let start = sorted[0]
    let end = start + 1
    for (let i = 1; i < sorted.length; i++) {
        const idx = sorted[i]
        if (idx === end) {
            end++
            continue
        }
        ranges.push({ start, end })
        start = idx
        end = idx + 1
    }
    ranges.push({ start, end })
    return ranges
}

