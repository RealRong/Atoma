import type { FuzzySearchField, FuzzySearchHit, FuzzySearchOptions, FuzzySearchResult } from './types'
import { indicesToRanges } from './highlight'

const normalizeText = (value: any, caseSensitive: boolean): string => {
    if (value === undefined || value === null) return ''
    const text = String(value)
    return caseSensitive ? text : text.toLowerCase()
}

const isWordCharCode = (code: number): boolean => {
    // a-z, 0-9, underscore, and a common CJK block used elsewhere in the project
    return (
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 95 ||
        (code >= 0x4e00 && code <= 0x9fa5)
    )
}

type SubsequenceMatch = { score: number; indices: number[] }

const matchSubsequence = (rawQuery: string, rawTarget: string): SubsequenceMatch | null => {
    if (!rawQuery) return null
    if (!rawTarget) return null

    const query = rawQuery
    const target = rawTarget

    const qLen = query.length
    const tLen = target.length
    if (qLen > tLen) return null

    const indices: number[] = []
    let qi = 0
    for (let ti = 0; ti < tLen; ti++) {
        if (target.charCodeAt(ti) === query.charCodeAt(qi)) {
            indices.push(ti)
            qi++
            if (qi >= qLen) break
        }
    }
    if (qi !== qLen) return null

    let score = 0
    let streak = 0
    let prev = -1

    for (let i = 0; i < indices.length; i++) {
        const idx = indices[i]
        const gap = prev === -1 ? idx : idx - prev - 1
        const isConsecutive = gap === 0

        if (isConsecutive) {
            streak++
            score += 20 + streak * 8
        } else {
            streak = 0
            score += 12
            if (gap > 0) score -= gap
        }

        const prevCharCode = idx > 0 ? target.charCodeAt(idx - 1) : 0
        const wordBoundary = idx === 0 || !isWordCharCode(prevCharCode)
        if (wordBoundary) score += 10

        prev = idx
    }

    const first = indices[0] ?? 0
    score += Math.max(0, 40 - first)
    score -= Math.floor((tLen - qLen) / 4)

    return { score, indices }
}

const splitTerms = (q: string): string[] => {
    return q
        .trim()
        .split(/\s+/g)
        .map(t => t.trim())
        .filter(Boolean)
}

const resolveFieldText = <T>(item: T, field: FuzzySearchField<T>, caseSensitive: boolean): { name: string; text: string; weight: number } => {
    if (typeof field === 'string') {
        return { name: field, text: normalizeText(resolvePath(item as any, field), caseSensitive), weight: 1 }
    }

    const name = field.field
    const weight = typeof field.weight === 'number' ? field.weight : 1
    const raw = typeof field.get === 'function' ? field.get(item) : resolvePath(item as any, field.field)
    let text = normalizeText(raw, caseSensitive)
    if (typeof field.maxChars === 'number' && field.maxChars > 0 && text.length > field.maxChars) {
        text = text.slice(0, field.maxChars)
    }
    return { name, text, weight }
}

const resolvePath = (obj: any, path: string): any => {
    if (!obj) return undefined
    if (!path) return undefined
    if (!path.includes('.')) return obj[path]
    const parts = path.split('.').filter(Boolean)
    let cur = obj
    for (const p of parts) {
        if (cur === undefined || cur === null) return undefined
        cur = cur[p]
    }
    return cur
}

export const fuzzySearch = <T>(items: T[], q: string, options: FuzzySearchOptions<T>): FuzzySearchResult<T> => {
    const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 50
    const threshold = typeof options.threshold === 'number' ? options.threshold : Number.NEGATIVE_INFINITY
    const caseSensitive = Boolean(options.caseSensitive)
    const returnHighlights = options.returnHighlights !== false

    const normalizedQ = normalizeText(q, caseSensitive)
    const terms = splitTerms(normalizedQ)
    if (terms.length === 0) return { q, hits: [] }

    const hits: Array<FuzzySearchHit<T> & { __idx: number }> = []

    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx]

        let bestScore = Number.NEGATIVE_INFINITY
        let bestField = ''
        let bestIndices: number[] = []

        for (const field of options.fields) {
            const resolved = resolveFieldText(item, field, caseSensitive)
            const text = resolved.text
            if (!text) continue

            let totalScore = 0
            const mergedIndices: number[] = []
            let ok = true

            for (const term of terms) {
                const m = matchSubsequence(term, text)
                if (!m) {
                    ok = false
                    break
                }
                totalScore += m.score
                mergedIndices.push(...m.indices)
            }

            if (!ok) continue

            totalScore = totalScore * resolved.weight

            if (totalScore > bestScore) {
                bestScore = totalScore
                bestField = resolved.name
                bestIndices = mergedIndices
            }
        }

        if (bestField && bestScore >= threshold) {
            const hit: FuzzySearchHit<T> & { __idx: number } = {
                item,
                score: bestScore,
                matchedField: bestField,
                __idx: idx
            }
            if (returnHighlights) {
                hit.highlights = { [bestField]: indicesToRanges(bestIndices) }
            }
            hits.push(hit)
        }
    }

    hits.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score
        return a.__idx - b.__idx
    })

    const sliced = hits.slice(0, limit).map(({ __idx: _idx, ...rest }) => rest)
    return { q, hits: sliced }
}

