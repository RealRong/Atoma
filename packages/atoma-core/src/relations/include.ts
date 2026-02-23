import type { FilterExpr, RelationPrefetchMode, RelationQuery } from 'atoma-types/core'

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeLimit(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.max(0, Math.floor(value))
}

function normalizePrefetch(value: unknown): RelationPrefetchMode | undefined {
    return value === 'on-mount' || value === 'on-change' || value === 'manual'
        ? value
        : undefined
}

function readQueryInput(value: unknown): unknown {
    if (!isRecord(value)) return undefined
    return 'query' in value ? value.query : value
}

function pickQuery(value: unknown): RelationQuery<unknown> | undefined {
    const input = readQueryInput(value)
    if (!isRecord(input)) return undefined

    const output: RelationQuery<unknown> = {}

    if ('filter' in input) output.filter = input.filter as RelationQuery<unknown>['filter']
    if ('sort' in input) output.sort = input.sort as RelationQuery<unknown>['sort']
    if ('limit' in input) output.limit = normalizeLimit(input.limit)

    return Object.keys(output).length ? output : undefined
}

export type IncludeOptions = Readonly<{
    query?: RelationQuery<unknown>
    live?: boolean
    prefetch?: RelationPrefetchMode
}>

export function pickIncludeOptions(value: unknown): IncludeOptions {
    if (!isRecord(value)) return {}

    const prefetch = normalizePrefetch(value.prefetch)
    const query = pickQuery(value)

    return {
        ...(query ? { query } : {}),
        ...(typeof value.live === 'boolean' ? { live: value.live } : {}),
        ...(prefetch ? { prefetch } : {})
    }
}

export function mergeIncludeQuery(
    base?: RelationQuery<unknown>,
    override?: RelationQuery<unknown>
): RelationQuery<unknown> {
    const baseQuery = pickQuery(base)
    const overrideQuery = pickQuery(override)

    if (!baseQuery && !overrideQuery) return {}

    if (!baseQuery) {
        return {
            ...overrideQuery
        }
    }

    if (!overrideQuery) {
        return {
            ...baseQuery
        }
    }

    const filter: FilterExpr | undefined = baseQuery.filter && overrideQuery.filter
        ? { op: 'and', args: [baseQuery.filter, overrideQuery.filter] }
        : (overrideQuery.filter ?? baseQuery.filter)

    return {
        filter,
        sort: overrideQuery.sort !== undefined ? overrideQuery.sort : baseQuery.sort,
        limit: overrideQuery.limit !== undefined ? overrideQuery.limit : baseQuery.limit
    }
}
