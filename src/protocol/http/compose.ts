import type { PageInfo } from '../batch/pagination'
import type { StandardError } from '../error/types'
import type { StandardEnvelope } from './envelope'

export function ok<T>(
    data?: T | T[] | null,
    options?: { pageInfo?: PageInfo; meta?: unknown }
): StandardEnvelope<T> {
    return {
        ok: true,
        ...(data !== undefined ? { data } : {}),
        ...(options?.pageInfo ? { pageInfo: options.pageInfo } : {}),
        ...(options && 'meta' in options ? { meta: options.meta } : {})
    }
}

export function error<T = unknown>(
    err: StandardError,
    options?: { meta?: unknown }
): StandardEnvelope<T> {
    return {
        ok: false,
        error: err,
        ...(options && 'meta' in options ? { meta: options.meta } : {})
    }
}

