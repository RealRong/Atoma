import type { FilterExpr, Query } from 'atoma-types/core'

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
    if (!base && !override) return {}

    if (!base) {
        return {
            ...override,
            page: mergeIncludePage(undefined, override?.page)
        }
    }

    if (!override) {
        return {
            ...base,
            page: mergeIncludePage(base.page, undefined)
        }
    }

    const filter: FilterExpr | undefined = base.filter && override.filter
        ? { op: 'and', args: [base.filter, override.filter] }
        : (override.filter ?? base.filter)

    return {
        filter,
        sort: override.sort !== undefined ? override.sort : base.sort,
        select: override.select !== undefined ? override.select : base.select,
        include: override.include !== undefined ? override.include : base.include,
        page: mergeIncludePage(base.page, override.page)
    }
}
