import type { PageInfo } from '../core/types'
import type { BatchOpResult } from './types'
import { Protocol } from '../protocol'

export function mapResults(results: any): Map<string, BatchOpResult> {
    return Protocol.batch.result.mapResults(results) as any
}

export function normalizeQueryEnvelope<T>(res: BatchOpResult): { data: T[]; pageInfo?: PageInfo } {
    if (Array.isArray(res.data)) {
        return res.pageInfo ? { data: res.data as T[], pageInfo: res.pageInfo } : { data: res.data as T[] }
    }
    return res.pageInfo ? { data: [], pageInfo: res.pageInfo } : { data: [] }
}

export function normalizeQueryFallback<T>(res: any): { data: T[]; pageInfo?: PageInfo } {
    if (Array.isArray(res)) return { data: res }
    if (res && typeof res === 'object' && Array.isArray(res.data)) return { data: res.data, pageInfo: res.pageInfo }
    return { data: [], pageInfo: res?.pageInfo }
}
