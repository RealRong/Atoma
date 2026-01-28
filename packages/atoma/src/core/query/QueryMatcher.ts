import { defaultTokenizer } from '../indexes/tokenizer'
import { levenshteinDistance } from '../indexes/utils'
import type { FilterExpr } from '#protocol'

export type TextOperator = 'and' | 'or'

export type MatchDefaults = {
    op?: TextOperator
    minTokenLength?: number
    tokenizer?: (text: string) => string[]
}

export type FuzzyDefaults = {
    op?: TextOperator
    distance?: 0 | 1 | 2
    minTokenLength?: number
    tokenizer?: (text: string) => string[]
}

export type FieldMatcherOptions = {
    match?: MatchDefaults
    fuzzy?: FuzzyDefaults
}

export type QueryMatcherOptions = {
    fields?: Record<string, FieldMatcherOptions>
}

const normalizeString = (value: any) => {
    if (value === undefined || value === null) return ''
    return String(value).toLowerCase()
}

const tokenize = (input: any, tokenizer?: (text: string) => string[], minTokenLength = 3): string[] => {
    const text = normalizeString(input)
    if (!text) return []
    const tk = tokenizer || defaultTokenizer
    return tk(text).filter(t => t.length >= minTokenLength)
}

const matchesMatch = (fieldValue: any, query: string, defaults?: MatchDefaults): boolean => {
    const operator: TextOperator = defaults?.op || 'and'
    const minTokenLength = defaults?.minTokenLength ?? 3
    const docTokens = tokenize(fieldValue, defaults?.tokenizer, minTokenLength)
    const queryTokens = tokenize(query, defaults?.tokenizer, minTokenLength)
    if (!queryTokens.length) return false
    if (!docTokens.length) return false
    const docSet = new Set(docTokens)
    if (operator === 'or') return queryTokens.some(t => docSet.has(t))
    return queryTokens.every(t => docSet.has(t))
}

const matchesFuzzy = (fieldValue: any, query: string, defaults?: FuzzyDefaults, distanceOverride?: 0 | 1 | 2): boolean => {
    const operator: TextOperator = defaults?.op || 'and'
    const distance: 0 | 1 | 2 = distanceOverride ?? defaults?.distance ?? 1
    const minTokenLength = defaults?.minTokenLength ?? 3
    const docTokens = tokenize(fieldValue, defaults?.tokenizer, minTokenLength)
    const queryTokens = tokenize(query, defaults?.tokenizer, minTokenLength)
    if (!queryTokens.length) return false
    if (!docTokens.length) return false

    const fuzzyHas = (q: string): boolean => {
        for (const t of docTokens) {
            if (Math.abs(t.length - q.length) > distance) continue
            if (levenshteinDistance(q, t, distance) <= distance) return true
        }
        return false
    }

    if (operator === 'or') return queryTokens.some(fuzzyHas)
    return queryTokens.every(fuzzyHas)
}

export const QueryMatcher = {
    matchesFilter<T extends Record<string, any>>(
        item: T,
        filter: FilterExpr,
        opts?: QueryMatcherOptions
    ): boolean {
        if (!filter) return true

        const op = (filter as any).op
        switch (op) {
            case 'and':
                return Array.isArray((filter as any).args)
                    ? (filter as any).args.every((f: any) => QueryMatcher.matchesFilter(item, f, opts))
                    : true
            case 'or':
                return Array.isArray((filter as any).args)
                    ? (filter as any).args.some((f: any) => QueryMatcher.matchesFilter(item, f, opts))
                    : false
            case 'not':
                return (filter as any).arg
                    ? !QueryMatcher.matchesFilter(item, (filter as any).arg, opts)
                    : true
            case 'eq':
                return (item as any)[(filter as any).field] === (filter as any).value
            case 'in': {
                const values = (filter as any).values
                return Array.isArray(values)
                    ? values.some((v: any) => (item as any)[(filter as any).field] === v)
                    : false
            }
            case 'gt':
                return (item as any)[(filter as any).field] > (filter as any).value
            case 'gte':
                return (item as any)[(filter as any).field] >= (filter as any).value
            case 'lt':
                return (item as any)[(filter as any).field] < (filter as any).value
            case 'lte':
                return (item as any)[(filter as any).field] <= (filter as any).value
            case 'startsWith': {
                const hay = normalizeString((item as any)[(filter as any).field])
                return hay.startsWith(normalizeString((filter as any).value))
            }
            case 'endsWith': {
                const hay = normalizeString((item as any)[(filter as any).field])
                return hay.endsWith(normalizeString((filter as any).value))
            }
            case 'contains': {
                const hay = normalizeString((item as any)[(filter as any).field])
                return hay.includes(normalizeString((filter as any).value))
            }
            case 'isNull':
                return (item as any)[(filter as any).field] === null
            case 'exists': {
                const v = (item as any)[(filter as any).field]
                return v !== undefined && v !== null
            }
            case 'text': {
                const field = (filter as any).field
                const query = (filter as any).query
                const mode = (filter as any).mode
                const distance = (filter as any).distance
                const defaults = opts?.fields?.[field]
                if (mode === 'fuzzy') {
                    return matchesFuzzy((item as any)[field], query, defaults?.fuzzy, distance)
                }
                return matchesMatch((item as any)[field], query, defaults?.match)
            }
            default:
                return true
        }
    }
}
