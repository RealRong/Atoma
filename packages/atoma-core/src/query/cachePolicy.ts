import type { Query } from 'atoma-types/core'

export type CacheWriteDecision =
    | { effectiveSkipStore: true; reason: 'select' | 'include' }
    | { effectiveSkipStore: false; reason?: undefined }

export function cachePolicy<T>(query?: Query<T>): CacheWriteDecision {
    const hasSelect = Boolean(Array.isArray(query?.select) && query.select.length)
    if (hasSelect) {
        return { effectiveSkipStore: true, reason: 'select' }
    }

    const include = query?.include
    const hasInclude = Boolean(include && typeof include === 'object' && Object.keys(include).length)
    if (hasInclude) {
        return { effectiveSkipStore: true, reason: 'include' }
    }

    return { effectiveSkipStore: false }
}
