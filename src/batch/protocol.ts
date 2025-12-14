import type { PageInfo } from '../core/types'
import type { BatchOpResult } from './types'

export function mapResults(results: any): Map<string, BatchOpResult> {
    const map = new Map<string, BatchOpResult>()
    if (!Array.isArray(results)) return map
    results.forEach((r: any) => {
        if (r && typeof r.opId === 'string') map.set(r.opId, r as BatchOpResult)
    })
    return map
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

