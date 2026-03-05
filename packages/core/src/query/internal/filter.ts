import type { FilterExpr } from '@atoma-js/types/core'
import { read } from '@atoma-js/shared'
import type { FuzzyDefaults, MatchDefaults } from './types'
import { defaultTokenizer, levenshteinDistance, lower, tokenize } from '../../shared/text'

const matchesMatch = (fieldValue: unknown, query: string, defaults?: MatchDefaults): boolean => {
    const operator = defaults?.op || 'and'
    const minTokenLength = defaults?.minTokenLength ?? 3
    const tk = defaults?.tokenizer ?? defaultTokenizer
    const docTokens = tokenize(fieldValue, tk, minTokenLength)
    const queryTokens = tokenize(query, tk, minTokenLength)
    if (!queryTokens.length || !docTokens.length) return false

    const docSet = new Set(docTokens)
    if (operator === 'or') return queryTokens.some(token => docSet.has(token))
    return queryTokens.every(token => docSet.has(token))
}

const matchesFuzzy = (fieldValue: unknown, query: string, defaults?: FuzzyDefaults, distanceOverride?: 0 | 1 | 2): boolean => {
    const operator = defaults?.op || 'and'
    const distance: 0 | 1 | 2 = distanceOverride ?? defaults?.distance ?? 1
    const minTokenLength = defaults?.minTokenLength ?? 3
    const tk = defaults?.tokenizer ?? defaultTokenizer
    const docTokens = tokenize(fieldValue, tk, minTokenLength)
    const queryTokens = tokenize(query, tk, minTokenLength)
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
            return read(item, filter.field) === filter.value
        case 'in': {
            const values = filter.values
            return Array.isArray(values)
                ? values.some(value => read(item, filter.field) === value)
                : false
        }
        case 'gt':
            return (read(item, filter.field) as number) > filter.value
        case 'gte':
            return (read(item, filter.field) as number) >= filter.value
        case 'lt':
            return (read(item, filter.field) as number) < filter.value
        case 'lte':
            return (read(item, filter.field) as number) <= filter.value
        case 'startsWith': {
            const haystack = lower(read(item, filter.field))
            return haystack.startsWith(lower(filter.value))
        }
        case 'endsWith': {
            const haystack = lower(read(item, filter.field))
            return haystack.endsWith(lower(filter.value))
        }
        case 'contains': {
            const haystack = lower(read(item, filter.field))
            return haystack.includes(lower(filter.value))
        }
        case 'isNull':
            return read(item, filter.field) === null
        case 'exists': {
            const value = read(item, filter.field)
            return value !== undefined && value !== null
        }
        case 'text': {
            const fieldValue = read(item, filter.field)
            if (filter.mode === 'fuzzy') {
                return matchesFuzzy(fieldValue, filter.query, undefined, filter.distance)
            }
            return matchesMatch(fieldValue, filter.query)
        }
        default:
            return false
    }
}
