import type { FilterExpr, RelationPrefetchMode, RelationQuery } from 'atoma-types/core'

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickQuery(value: unknown): RelationQuery<unknown> | undefined {
    const input = isRecord(value) && 'query' in value
        ? value.query
        : value
    if (!isRecord(input)) return undefined

    const query: RelationQuery<unknown> = {}
    const normalizedLimit = typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.max(0, Math.floor(input.limit))
        : undefined

    if ('filter' in input) query.filter = input.filter as RelationQuery<unknown>['filter']
    if ('sort' in input) query.sort = input.sort as RelationQuery<unknown>['sort']
    if ('limit' in input) query.limit = normalizedLimit

    return Object.keys(query).length ? query : undefined
}

export type IncludeOptions = Readonly<{
    query?: RelationQuery<unknown>
    live?: boolean
    prefetch?: RelationPrefetchMode
}>

export function pickIncludeOptions(value: unknown): IncludeOptions {
    if (!isRecord(value)) return {}

    const prefetch = value.prefetch === 'on-mount' || value.prefetch === 'on-change' || value.prefetch === 'manual'
        ? value.prefetch as RelationPrefetchMode
        : undefined
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
    if (!base && !override) return {}
    if (!base) {
        return {
            ...override
        }
    }

    if (!override) {
        return {
            ...base
        }
    }

    const filter: FilterExpr | undefined = base.filter && override.filter
        ? { op: 'and', args: [base.filter, override.filter] }
        : (override.filter ?? base.filter)

    return {
        filter,
        sort: override.sort !== undefined ? override.sort : base.sort,
        limit: override.limit !== undefined ? override.limit : base.limit
    }
}
