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
        .filter(t => t.length <= 32)
}
