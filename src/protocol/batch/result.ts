import type { BatchResult } from './types'

export function mapResults(results: unknown): Map<string, BatchResult> {
    const map = new Map<string, BatchResult>()
    if (!Array.isArray(results)) return map
    results.forEach((r: any) => {
        if (r && typeof r.opId === 'string') map.set(r.opId, r as BatchResult)
    })
    return map
}
