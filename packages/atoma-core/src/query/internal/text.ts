type SegmenterGranularity = 'grapheme' | 'word' | 'sentence'

interface IntlWordSegment {
    segment: string
    index: number
    input: string
    isWordLike: boolean
}

interface IntlSegmenter {
    segment(input: string): Iterable<IntlWordSegment>
}

type IntlWithSegmenter = typeof Intl & {
    Segmenter?: new (locales?: string | string[], options?: { granularity?: SegmenterGranularity }) => IntlSegmenter
}

const intlWithSegmenter: IntlWithSegmenter = Intl as IntlWithSegmenter
let cachedSegmenter: IntlSegmenter | null = null

export const defaultTokenizer = (text: string): string[] => {
    if (typeof intlWithSegmenter.Segmenter === 'function') {
        if (!cachedSegmenter) {
            cachedSegmenter = new intlWithSegmenter.Segmenter(undefined, { granularity: 'word' })
        }

        return Array.from(cachedSegmenter.segment(text))
            .filter(seg => seg.isWordLike)
            .map(seg => seg.segment.toLowerCase())
            .filter(token => token.length > 0 && token.length <= 32)
    }

    return String(text)
        .toLowerCase()
        .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
        .filter(Boolean)
        .filter(token => token.length <= 32)
}

export const levenshteinDistance = (a: string, b: string, maxDistance?: number): number => {
    if (a === b) return 0

    let left = a
    let right = b
    let m = left.length
    let n = right.length

    if (m === 0) {
        if (maxDistance !== undefined) return n > maxDistance ? maxDistance + 1 : n
        return n
    }

    if (n === 0) {
        if (maxDistance !== undefined) return m > maxDistance ? maxDistance + 1 : m
        return m
    }

    if (m > n) {
        ;[left, right] = [right, left]
        ;[m, n] = [n, m]
    }

    let prev = new Uint32Array(n + 1)
    let curr = new Uint32Array(n + 1)

    if (maxDistance === undefined) {
        for (let j = 0; j <= n; j++) prev[j] = j

        for (let i = 1; i <= m; i++) {
            curr[0] = i
            const leftChar = left.charCodeAt(i - 1)
            for (let j = 1; j <= n; j++) {
                const cost = leftChar === right.charCodeAt(j - 1) ? 0 : 1
                const del = prev[j] + 1
                const ins = curr[j - 1] + 1
                const sub = prev[j - 1] + cost
                curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub
            }
            const tmp = prev
            prev = curr
            curr = tmp
        }

        return prev[n]
    }

    const limit = maxDistance
    const big = limit + 1
    const offset = n - m
    if (offset > limit) return big

    prev.fill(big)
    const initMax = Math.min(n, offset + limit)
    for (let j = 0; j <= initMax; j++) prev[j] = j

    for (let i = 1; i <= m; i++) {
        const center = i + offset
        const minJ = Math.max(1, center - limit)
        const maxJ = Math.min(n, center + limit)

        curr[0] = i
        if (minJ > 1) curr[minJ - 1] = big
        if (maxJ < n) curr[maxJ + 1] = big

        let rowMin = big
        const leftChar = left.charCodeAt(i - 1)
        for (let j = minJ; j <= maxJ; j++) {
            const cost = leftChar === right.charCodeAt(j - 1) ? 0 : 1
            const del = prev[j] + 1
            const ins = curr[j - 1] + 1
            const sub = prev[j - 1] + cost
            const v = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub
            curr[j] = v
            if (v < rowMin) rowMin = v
        }

        if (rowMin > limit) return big
        const tmp = prev
        prev = curr
        curr = tmp
    }

    const result = prev[n]
    return result > limit ? big : result
}
