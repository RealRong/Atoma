export type HighlightRange = { start: number; end: number }

export type FuzzySearchField<T> =
    | string
    | {
        field: string
        weight?: number
        maxChars?: number
        get?: (item: T) => any
    }

export interface FuzzySearchOptions<T> {
    fields: Array<FuzzySearchField<T>>
    limit?: number
    threshold?: number
    caseSensitive?: boolean
    returnHighlights?: boolean
}

export interface FuzzySearchHit<T> {
    item: T
    score: number
    matchedField: string
    highlights?: Record<string, HighlightRange[]>
}

export interface FuzzySearchResult<T> {
    q: string
    hits: Array<FuzzySearchHit<T>>
}

