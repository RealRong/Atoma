import { defaultTokenizer } from '../indexes/tokenizer'
import { levenshteinDistance } from '../indexes/utils'

export type TextOperator = 'and' | 'or'

export type MatchSpec =
    | string
    | {
        q: string
        op?: TextOperator
        minTokenLength?: number
        tokenizer?: (text: string) => string[]
    }

export type FuzzySpec =
    | string
    | {
        q: string
        op?: TextOperator
        distance?: 0 | 1 | 2
        minTokenLength?: number
        tokenizer?: (text: string) => string[]
    }

export type FieldMatcherOptions = {
    match?: Omit<Exclude<MatchSpec, string>, 'q'>
    fuzzy?: Omit<Exclude<FuzzySpec, string>, 'q'>
}

export type QueryMatcherOptions = {
    fields?: Record<string, FieldMatcherOptions>
}

type WhereValue =
    | any
    | {
        eq?: any
        in?: any[]
        gt?: number
        gte?: number
        lt?: number
        lte?: number
        contains?: string
        startsWith?: string
        endsWith?: string
        match?: MatchSpec
        fuzzy?: FuzzySpec
    }

const normalizeString = (value: any) => {
    if (value === undefined || value === null) return ''
    return String(value).toLowerCase()
}

const resolveMatchSpec = (spec: MatchSpec, defaults?: FieldMatcherOptions['match']) => {
    if (typeof spec === 'string') return { q: spec, ...(defaults || {}) }
    return { ...defaults, ...spec }
}

const resolveFuzzySpec = (spec: FuzzySpec, defaults?: FieldMatcherOptions['fuzzy']) => {
    if (typeof spec === 'string') return { q: spec, ...(defaults || {}) }
    return { ...defaults, ...spec }
}

const tokenize = (input: any, tokenizer?: (text: string) => string[], minTokenLength = 3): string[] => {
    const text = normalizeString(input)
    if (!text) return []
    const tk = tokenizer || defaultTokenizer
    return tk(text).filter(t => t.length >= minTokenLength)
}

const matchesMatch = (fieldValue: any, spec: MatchSpec, defaults?: FieldMatcherOptions['match']): boolean => {
    const resolved = resolveMatchSpec(spec, defaults)
    const operator: TextOperator = resolved.op || 'and'
    const minTokenLength = resolved.minTokenLength ?? 3
    const docTokens = tokenize(fieldValue, resolved.tokenizer, minTokenLength)
    const queryTokens = tokenize(resolved.q, resolved.tokenizer, minTokenLength)
    if (!queryTokens.length) return false
    if (!docTokens.length) return false
    const docSet = new Set(docTokens)
    if (operator === 'or') return queryTokens.some(t => docSet.has(t))
    return queryTokens.every(t => docSet.has(t))
}

const matchesFuzzy = (fieldValue: any, spec: FuzzySpec, defaults?: FieldMatcherOptions['fuzzy']): boolean => {
    const resolved = resolveFuzzySpec(spec, defaults)
    const operator: TextOperator = resolved.op || 'and'
    const distance: 0 | 1 | 2 = resolved.distance ?? 1
    const minTokenLength = resolved.minTokenLength ?? 3
    const docTokens = tokenize(fieldValue, resolved.tokenizer, minTokenLength)
    const queryTokens = tokenize(resolved.q, resolved.tokenizer, minTokenLength)
    if (!queryTokens.length) return false
    if (!docTokens.length) return false

    const fuzzyHas = (q: string): boolean => {
        for (const t of docTokens) {
            if (Math.abs(t.length - q.length) > distance) continue
            if (levenshteinDistance(q, t) <= distance) return true
        }
        return false
    }

    if (operator === 'or') return queryTokens.some(fuzzyHas)
    return queryTokens.every(fuzzyHas)
}

const matchesCondition = (value: any, condition: WhereValue, fieldDefaults?: FieldMatcherOptions): boolean => {
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        const { eq, in: inArr, gt, gte, lt, lte, contains, startsWith, endsWith, match, fuzzy } = condition as any

        if (eq !== undefined) {
            return value === eq
        }

        if (inArr && Array.isArray(inArr)) {
            if (!inArr.some(v => v === value)) return false
        }
        if (gt !== undefined && !(value > gt)) return false
        if (gte !== undefined && !(value >= gte)) return false
        if (lt !== undefined && !(value < lt)) return false
        if (lte !== undefined && !(value <= lte)) return false

        const haystack = normalizeString(value)
        if (startsWith !== undefined) {
            if (!haystack.startsWith(normalizeString(startsWith))) return false
        }
        if (endsWith !== undefined) {
            if (!haystack.endsWith(normalizeString(endsWith))) return false
        }
        if (contains !== undefined) {
            const needle = normalizeString(contains)
            if (!haystack.includes(needle)) return false
        }

        if (match !== undefined) {
            if (!matchesMatch(value, match, fieldDefaults?.match)) return false
        }
        if (fuzzy !== undefined) {
            if (!matchesFuzzy(value, fuzzy, fieldDefaults?.fuzzy)) return false
        }

        return true
    }

    return value === condition
}

export const QueryMatcher = {
    matchesWhere<T extends Record<string, any>>(
        item: T,
        where: any,
        opts?: QueryMatcherOptions
    ): boolean {
        if (!where) return true
        if (typeof where === 'function') return Boolean(where(item))
        if (typeof where !== 'object') return true

        return Object.entries(where).every(([field, cond]) => {
            const defaults = opts?.fields?.[field]
            return matchesCondition((item as any)[field], cond as WhereValue, defaults)
        })
    }
}

