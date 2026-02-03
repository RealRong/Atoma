import type { Query } from 'atoma-types/core'

export type CacheWriteDecision =
    | { effectiveSkipStore: true; reason: 'select' }
    | { effectiveSkipStore: false; reason?: undefined }

export function resolveCachePolicy<T>(query?: Query<T>): CacheWriteDecision {
    const effectiveSkipStore = Boolean(Array.isArray((query as any)?.select) && (query as any).select.length)
    if (!effectiveSkipStore) return { effectiveSkipStore: false }

    return { effectiveSkipStore: true, reason: 'select' }
}
