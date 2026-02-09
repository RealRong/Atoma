import type { FilterExpr } from 'atoma-types/core'
import type { FuzzyDefaults, MatchDefaults } from './types'
import { defaultTokenizer, levenshteinDistance } from './text'

const normalizeString = (value: unknown) => {
    if (value === undefined || value === null) return ''
    return String(value).toLowerCase()
}

const readField = <T extends object>(item: T, field: string): unknown => {
    return (item as Record<string, unknown>)[field]
}

const tokenize = (input: unknown, tokenizer?: (text: string) => string[], minTokenLength = 3): string[] => {
    const text = normalizeString(input)
    if (!text) return []

    const tk = tokenizer || defaultTokenizer
    return tk(text).filter((token: string) => token.length >= minTokenLength)
}

const matchesMatch = (fieldValue: unknown, query: string, defaults?: MatchDefaults): boolean => {
    const operator = defaults?.op || 'and'
    const minTokenLength = defaults?.minTokenLength ?? 3
    const docTokens = tokenize(fieldValue, defaults?.tokenizer, minTokenLength)
    const queryTokens = tokenize(query, defaults?.tokenizer, minTokenLength)
    if (!queryTokens.length || !docTokens.length) return false

    const docSet = new Set(docTokens)
    if (operator === 'or') return queryTokens.some(token => docSet.has(token))
    return queryTokens.every(token => docSet.has(token))
}

const matchesFuzzy = (fieldValue: unknown, query: string, defaults?: FuzzyDefaults, distanceOverride?: 0 | 1 | 2): boolean => {
    const operator = defaults?.op || 'and'
    const distance: 0 | 1 | 2 = distanceOverride ?? defaults?.distance ?? 1
    const minTokenLength = defaults?.minTokenLength ?? 3
    const docTokens = tokenize(fieldValue, defaults?.tokenizer, minTokenLength)
    const queryTokens = tokenize(query, defaults?.tokenizer, minTokenLength)
    if (!queryTokens.length || !docTokens.length) return false

    const fuzzyHas = (needle: string): boolean => {
        for (const token of docTokens) {
            if (Math.abs(token.length - needle.length) > distance) continue
            if (levenshteinDistance(needle, token, distance) <= distance) return true
        }
        return false
    }

    if (operator === 'or') return queryTokens.some(fuzzyHas)
    return queryTokens.every(fuzzyHas)
}

export function matchesFilter<T extends object>(
    item: T,
    filter: FilterExpr
): boolean {
    const op = filter.op

    switch (op) {
        case 'and':
            return Array.isArray(filter.args)
                ? filter.args.every((child) => matchesFilter(item, child))
                : true
        case 'or':
            return Array.isArray(filter.args)
                ? filter.args.some((child) => matchesFilter(item, child))
                : false
        case 'not':
            return filter.arg
                ? !matchesFilter(item, filter.arg)
                : true
        case 'eq':
            return readField(item, filter.field) === filter.value
        case 'in': {
            const values = filter.values
            return Array.isArray(values)
                ? values.some(value => readField(item, filter.field) === value)
                : false
        }
        case 'gt':
            return (readField(item, filter.field) as number) > filter.value
        case 'gte':
            return (readField(item, filter.field) as number) >= filter.value
        case 'lt':
            return (readField(item, filter.field) as number) < filter.value
        case 'lte':
            return (readField(item, filter.field) as number) <= filter.value
        case 'startsWith': {
            const haystack = normalizeString(readField(item, filter.field))
            return haystack.startsWith(normalizeString(filter.value))
        }
        case 'endsWith': {
            const haystack = normalizeString(readField(item, filter.field))
            return haystack.endsWith(normalizeString(filter.value))
        }
        case 'contains': {
            const haystack = normalizeString(readField(item, filter.field))
            return haystack.includes(normalizeString(filter.value))
        }
        case 'isNull':
            return readField(item, filter.field) === null
        case 'exists': {
            const value = readField(item, filter.field)
            return value !== undefined && value !== null
        }
        case 'text': {
            const fieldValue = readField(item, filter.field)
            if (filter.mode === 'fuzzy') {
                return matchesFuzzy(fieldValue, filter.query, undefined, filter.distance)
            }
            return matchesMatch(fieldValue, filter.query)
        }
        default:
            return false
    }
}
