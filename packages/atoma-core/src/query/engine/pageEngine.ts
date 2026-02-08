import type { PageInfo, PageSpec, SortRule } from 'atoma-types/core'
import { decodeCursorToken, encodeCursorToken } from '../cursor'
import { compareItemToValues, getSortValues, isSameSortRules } from './sortEngine'

type PageResult<T> = {
    data: T[]
    pageInfo?: PageInfo
}

export function applyPage<T extends object>(
    sorted: T[],
    page: PageSpec,
    sort: SortRule[]
): PageResult<T> {
    if (page.mode === 'offset') {
        const offset = normalizeOptionalNumber(page.offset) ?? 0
        const limit = normalizeOptionalNumber(page.limit)
        const slice = typeof limit === 'number'
            ? sorted.slice(offset, offset + limit)
            : sorted.slice(offset)
        const hasNext = typeof limit === 'number' ? (offset + limit < sorted.length) : false
        const pageInfo: PageInfo = {
            hasNext,
            ...(page.includeTotal ? { total: sorted.length } : {})
        }
        return { data: slice, pageInfo }
    }

    const limit = normalizeOptionalNumber(page.limit) ?? 50
    const after = page.after
    const before = page.before

    if (after || before) {
        const token = after ?? before
        const payload = token ? decodeCursorToken(token) : null
        if (!payload) throw new Error('[Atoma] Invalid cursor token')
        if (!isSameSortRules(payload.sort, sort)) {
            throw new Error('[Atoma] Cursor sort mismatch')
        }

        const cursorValues = payload.values
        const compareToCursor = (item: T) => compareItemToValues(item, cursorValues, sort)
        const filteredByCursor = sorted.filter(item => {
            const compared = compareToCursor(item)
            return after ? (compared > 0) : (compared < 0)
        })

        const slice = after
            ? filteredByCursor.slice(0, limit)
            : filteredByCursor.slice(Math.max(0, filteredByCursor.length - limit))

        const hasNext = filteredByCursor.length > slice.length
        const cursorItem = after ? slice[slice.length - 1] : slice[0]
        const pageInfo: PageInfo = {
            hasNext,
            ...(cursorItem ? { cursor: encodeCursorToken(sort, getSortValues(cursorItem, sort)) } : {})
        }
        return { data: slice, pageInfo }
    }

    const slice = sorted.slice(0, limit)
    const hasNext = limit < sorted.length
    const last = slice[slice.length - 1]
    const pageInfo: PageInfo = {
        hasNext,
        ...(last ? { cursor: encodeCursorToken(sort, getSortValues(last, sort)) } : {})
    }
    return { data: slice, pageInfo }
}

function normalizeOptionalNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.max(0, Math.floor(value))
}
