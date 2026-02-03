import type { Entity, FilterExpr, FuzzyDefaults, MatchDefaults, PageInfo, Query, QueryMatcherOptions, SortRule } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreIndexes } from '../../indexes/StoreIndexes'
import { defaultTokenizer } from '../../indexes/tokenizer'
import { levenshteinDistance } from '../../indexes/utils'
import { decodeCursorToken, encodeCursorToken } from '../cursor'
import { normalizeQuery } from '../normalize'
import { summarizeQuery } from '../summary'

type ExecuteOptions = {
    preSorted?: boolean
    matcher?: QueryMatcherOptions
}

const normalizeString = (value: any) => {
    if (value === undefined || value === null) return ''
    return String(value).toLowerCase()
}

const tokenize = (input: any, tokenizer?: (text: string) => string[], minTokenLength = 3): string[] => {
    const text = normalizeString(input)
    if (!text) return []
    const tk = tokenizer || defaultTokenizer
    return tk(text).filter((t: string) => t.length >= minTokenLength)
}

const matchesMatch = (fieldValue: any, query: string, defaults?: MatchDefaults): boolean => {
    const operator = (defaults as any)?.op || 'and'
    const minTokenLength = (defaults as any)?.minTokenLength ?? 3
    const docTokens = tokenize(fieldValue, (defaults as any)?.tokenizer, minTokenLength)
    const queryTokens = tokenize(query, (defaults as any)?.tokenizer, minTokenLength)
    if (!queryTokens.length) return false
    if (!docTokens.length) return false
    const docSet = new Set(docTokens)
    if (operator === 'or') return queryTokens.some(t => docSet.has(t))
    return queryTokens.every(t => docSet.has(t))
}

const matchesFuzzy = (fieldValue: any, query: string, defaults?: FuzzyDefaults, distanceOverride?: 0 | 1 | 2): boolean => {
    const operator = (defaults as any)?.op || 'and'
    const distance: 0 | 1 | 2 = distanceOverride ?? (defaults as any)?.distance ?? 1
    const minTokenLength = (defaults as any)?.minTokenLength ?? 3
    const docTokens = tokenize(fieldValue, (defaults as any)?.tokenizer, minTokenLength)
    const queryTokens = tokenize(query, (defaults as any)?.tokenizer, minTokenLength)
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

function matchesFilter<T extends Record<string, any>>(
    item: T,
    filter: FilterExpr,
    opts?: QueryMatcherOptions
): boolean {
    if (!filter) return true

    const op = (filter as any).op
    switch (op) {
        case 'and':
            return Array.isArray((filter as any).args)
                ? (filter as any).args.every((f: any) => matchesFilter(item, f, opts))
                : true
        case 'or':
            return Array.isArray((filter as any).args)
                ? (filter as any).args.some((f: any) => matchesFilter(item, f, opts))
                : false
        case 'not':
            return (filter as any).arg
                ? !matchesFilter(item, (filter as any).arg, opts)
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

export function executeLocalQuery<T extends Record<string, any>>(
    items: T[],
    query: Query,
    opts?: ExecuteOptions
): { data: T[]; pageInfo?: PageInfo } {
    const normalized = normalizeQuery(query)
    const filter = normalized.filter
    const filtered = filter
        ? items.filter(item => matchesFilter(item, filter, opts?.matcher))
        : items.slice()

    const sorted = opts?.preSorted ? filtered : filtered.slice().sort(compareBy(normalized.sort))

    if (!normalized.page) {
        const data = projectSelect(sorted, normalized.select)
        return { data }
    }

    if (normalized.page.mode === 'offset') {
        const offset = normalizeOptionalNumber((normalized.page as any).offset) ?? 0
        const limit = normalizeOptionalNumber((normalized.page as any).limit)
        const slice = typeof limit === 'number'
            ? sorted.slice(offset, offset + limit)
            : sorted.slice(offset)
        const hasNext = typeof limit === 'number' ? (offset + limit < sorted.length) : false
        const pageInfo: PageInfo = {
            hasNext,
            ...((normalized.page as any).includeTotal ? { total: sorted.length } : {})
        }
        return { data: projectSelect(slice, normalized.select), pageInfo }
    }

    const limit = normalizeOptionalNumber((normalized.page as any).limit) ?? 50
    const after = (normalized.page as any).after as string | undefined
    const before = (normalized.page as any).before as string | undefined

    if (after || before) {
        const token = after ?? before
        const payload = token ? decodeCursorToken(token) : null
        if (!payload) throw new Error('[Atoma] Invalid cursor token')
        const cursorValues = payload.values
        const compareToCursor = (item: T) => compareItemToValues(item, cursorValues, normalized.sort)
        const filteredByCursor = sorted.filter(item => {
            const cmp = compareToCursor(item)
            return after ? (cmp > 0) : (cmp < 0)
        })

        const slice = after
            ? filteredByCursor.slice(0, limit)
            : filteredByCursor.slice(Math.max(0, filteredByCursor.length - limit))

        const hasNext = filteredByCursor.length > slice.length
        const cursorItem = after ? slice[slice.length - 1] : slice[0]
        const pageInfo: PageInfo = {
            hasNext,
            ...(cursorItem ? { cursor: encodeCursorToken(normalized.sort, getSortValues(cursorItem, normalized.sort)) } : {})
        }
        return { data: projectSelect(slice, normalized.select), pageInfo }
    }

    const slice = sorted.slice(0, limit)
    const hasNext = limit < sorted.length
    const last = slice[slice.length - 1]
    const pageInfo: PageInfo = {
        hasNext,
        ...(last ? { cursor: encodeCursorToken(normalized.sort, getSortValues(last, normalized.sort)) } : {})
    }
    return { data: projectSelect(slice, normalized.select), pageInfo }
}

export function evaluateWithIndexes<T extends Entity>(params: {
    mapRef: Map<EntityId, T>
    query: Query<T>
    indexes: StoreIndexes<T> | null
    matcher?: QueryMatcherOptions
    emit: (type: string, payload: any) => void
    explain?: Record<string, any>
}): { data: T[]; pageInfo?: any } {
    const { mapRef, query, indexes, matcher, emit, explain } = params

    const paramsSummary = summarizeQuery(query)
    const candidateRes = indexes ? indexes.collectCandidates(query?.filter as any) : { kind: 'unsupported' as const }
    const plan = indexes?.getLastQueryPlan()

    emit('query:index', {
        params: { filterFields: paramsSummary.filterFields },
        result: candidateRes.kind === 'candidates'
            ? { kind: 'candidates', exactness: candidateRes.exactness, count: candidateRes.ids.size }
            : { kind: candidateRes.kind },
        plan
    })

    if (explain) {
        ;(explain as any).index = {
            kind: candidateRes.kind,
            ...(candidateRes.kind === 'candidates' ? { exactness: candidateRes.exactness, candidates: candidateRes.ids.size } : {}),
            ...(plan ? { lastQueryPlan: plan } : {})
        }
    }

    if (candidateRes.kind === 'empty') {
        emit('query:finalize', { inputCount: 0, outputCount: 0, params: paramsSummary })
        if (explain) {
            ;(explain as any).finalize = { inputCount: 0, outputCount: 0, paramsSummary }
        }
        return { data: [] }
    }

    const source =
        candidateRes.kind === 'candidates'
            ? (() => {
                const out: T[] = []
                for (const id of candidateRes.ids) {
                    const item = mapRef.get(id)
                    if (item !== undefined) out.push(item)
                }
                return out
            })()
            : Array.from(mapRef.values()) as T[]

    const effectiveQuery =
        candidateRes.kind === 'candidates'
        && candidateRes.exactness === 'exact'
        && query?.filter
            ? ({ ...query, filter: undefined } as Query<T>)
            : query

    const out = executeLocalQuery(source as any, effectiveQuery as any, { preSorted: false, matcher })

    emit('query:finalize', { inputCount: source.length, outputCount: out.data.length, params: paramsSummary })
    if (explain) {
        ;(explain as any).finalize = { inputCount: source.length, outputCount: out.data.length, paramsSummary }
    }

    return out as any
}

function normalizeOptionalNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.max(0, Math.floor(value))
}

function compareBy<T>(rules: SortRule[]): (a: T, b: T) => number {
    return (a, b) => {
        for (const rule of rules) {
            const av = (a as any)[rule.field]
            const bv = (b as any)[rule.field]
            if (av === bv) continue
            if (av === undefined || av === null) return 1
            if (bv === undefined || bv === null) return -1
            if (av > bv) return rule.dir === 'desc' ? -1 : 1
            if (av < bv) return rule.dir === 'desc' ? 1 : -1
        }
        return 0
    }
}

function compareItemToValues<T>(item: T, values: unknown[], rules: SortRule[]): number {
    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i]
        const av = (item as any)[rule.field]
        const bv = values[i]
        if (av === bv) continue
        if (av === undefined || av === null) return 1
        if (bv === undefined || bv === null) return -1
        if (av > bv) return rule.dir === 'desc' ? -1 : 1
        if (av < bv) return rule.dir === 'desc' ? 1 : -1
    }
    return 0
}

function getSortValues<T>(item: T, rules: SortRule[]): unknown[] {
    return rules.map(r => (item as any)[r.field])
}

function projectSelect<T extends Record<string, any>>(data: T[], select?: string[]): T[] {
    if (!select || select.length === 0) return data
    return data.map(item => {
        const out: any = {}
        for (const field of select) {
            out[field] = (item as any)[field]
        }
        return out
    })
}
