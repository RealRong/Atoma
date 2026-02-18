import type { FilterExpr, Query } from 'atoma-types/core'

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickQuery(value: unknown): Query<unknown> | undefined {
    if (!isRecord(value)) return undefined

    const output: Query<unknown> = {}

    if ('filter' in value) output.filter = value.filter as Query<unknown>['filter']
    if ('sort' in value) output.sort = value.sort as Query<unknown>['sort']
    if ('select' in value) output.select = value.select as Query<unknown>['select']
    if ('page' in value) output.page = value.page as Query<unknown>['page']

    if ('include' in value) {
        const nested = pickInclude(value.include)
        if (nested !== undefined) output.include = nested
    }

    return output
}

function pickInclude(value: unknown): Record<string, Query<unknown>> | undefined {
    if (!isRecord(value)) return undefined

    const output: Record<string, Query<unknown>> = {}
    Object.entries(value).forEach(([name, entry]) => {
        const query = pickQuery(entry)
        if (!query) return
        output[name] = query
    })

    return Object.keys(output).length ? output : undefined
}

export function pickIncludeQuery(value: unknown): Query<unknown> | undefined {
    return pickQuery(value)
}

export function resolveLimit(page: unknown): number | undefined {
    if (!page || typeof page !== 'object' || Array.isArray(page)) return undefined

    const raw = (page as { limit?: unknown }).limit
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined

    return Math.max(0, Math.floor(raw))
}

function mergeIncludePage(basePage: unknown, overridePage: unknown): Query<unknown>['page'] | undefined {
    const page = overridePage !== undefined ? overridePage : basePage
    const limit = resolveLimit(page)
    if (limit === undefined) return undefined

    return {
        mode: 'offset',
        limit,
        offset: 0,
        includeTotal: false
    }
}

export function mergeIncludeQuery(base?: Query<unknown>, override?: Query<unknown>): Query<unknown> {
    const baseQuery = pickQuery(base)
    const overrideQuery = pickQuery(override)

    if (!baseQuery && !overrideQuery) return {}

    if (!baseQuery) {
        return {
            ...overrideQuery,
            page: mergeIncludePage(undefined, overrideQuery?.page)
        }
    }

    if (!overrideQuery) {
        return {
            ...baseQuery,
            page: mergeIncludePage(baseQuery.page, undefined)
        }
    }

    const filter: FilterExpr | undefined = baseQuery.filter && overrideQuery.filter
        ? { op: 'and', args: [baseQuery.filter, overrideQuery.filter] }
        : (overrideQuery.filter ?? baseQuery.filter)

    return {
        filter,
        sort: overrideQuery.sort !== undefined ? overrideQuery.sort : baseQuery.sort,
        select: overrideQuery.select !== undefined ? overrideQuery.select : baseQuery.select,
        include: overrideQuery.include !== undefined ? overrideQuery.include : baseQuery.include,
        page: mergeIncludePage(baseQuery.page, overrideQuery.page)
    }
}
