import type { PageInfo, Query, SortRule } from 'atoma-types/protocol'
import { decodeCursorToken, encodeCursorToken } from '../cursor'
import { normalizeQuery } from '../normalize'
import { QueryMatcher } from '../QueryMatcher'
import type { QueryMatcherOptions } from 'atoma-types/core'

type ExecuteOptions = {
    preSorted?: boolean
    matcher?: QueryMatcherOptions
}

export function executeLocalQuery<T extends Record<string, any>>(
    items: T[],
    query: Query,
    opts?: ExecuteOptions
): { data: T[]; pageInfo?: PageInfo } {
    const normalized = normalizeQuery(query)
    const filter = normalized.filter
    const filtered = filter
        ? items.filter(item => QueryMatcher.matchesFilter(item, filter, opts?.matcher))
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
    if (!select || !select.length) return data
    return data.map(item => {
        const out: Record<string, any> = {}
        select.forEach(f => {
            if (Object.prototype.hasOwnProperty.call(item, f)) out[f] = (item as any)[f]
        })
        return out as T
    })
}
