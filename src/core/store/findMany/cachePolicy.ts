import type { FindManyOptions } from '../../types'

export type CacheWriteDecision =
    | { effectiveSkipStore: true; reason: 'skipStore' | 'sparseFields' }
    | { effectiveSkipStore: false; reason?: undefined }

export function resolveCachePolicy<T>(options?: FindManyOptions<T>): CacheWriteDecision {
    const effectiveSkipStore = Boolean(options?.skipStore || (options as any)?.fields?.length)
    if (!effectiveSkipStore) return { effectiveSkipStore: false }

    return {
        effectiveSkipStore: true,
        reason: options?.skipStore ? 'skipStore' : 'sparseFields'
    }
}

