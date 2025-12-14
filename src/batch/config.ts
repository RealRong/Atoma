import { normalizePositiveInt } from './utils'

type BatchEngineConfigLike = {
    maxQueueLength?: number | { query?: number; write?: number }
    maxBatchSize?: number
    maxOpsPerRequest?: number
}

export function normalizeMaxQueueLength(config: BatchEngineConfigLike, lane: 'query' | 'write') {
    const cfg = config.maxQueueLength
    if (typeof cfg === 'number') {
        return normalizePositiveInt(cfg) ?? Infinity
    }
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        const v = lane === 'query' ? (cfg as any).query : (cfg as any).write
        return normalizePositiveInt(v) ?? Infinity
    }
    return Infinity
}

export function isWriteQueueFull(config: BatchEngineConfigLike, writePendingCount: number) {
    const maxLen = normalizeMaxQueueLength(config, 'write')
    if (maxLen === Infinity) return false
    return writePendingCount >= maxLen
}

export function normalizeMaxBatchSize(config: BatchEngineConfigLike) {
    const n = config.maxBatchSize
    return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? Math.floor(n) : Infinity
}

export function normalizeMaxOpsPerRequest(config: BatchEngineConfigLike) {
    const n = config.maxOpsPerRequest
    return (typeof n === 'number' && Number.isFinite(n) && n > 0) ? Math.floor(n) : Infinity
}

export function normalizeMaxQueryOpsPerRequest(config: BatchEngineConfigLike) {
    const a = normalizeMaxBatchSize(config)
    const b = normalizeMaxOpsPerRequest(config)
    return Math.min(a, b)
}

