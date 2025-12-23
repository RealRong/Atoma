import type { SyncBackoffConfig } from '../types'

export function computeBackoffDelayMs(attempt: number, config?: SyncBackoffConfig, random: () => number = Math.random): number {
    const baseDelayMs = Math.max(0, Math.floor(config?.baseDelayMs ?? 300))
    const maxDelayMs = Math.max(baseDelayMs, Math.floor(config?.maxDelayMs ?? 30_000))
    const jitterRatio = Math.min(1, Math.max(0, config?.jitterRatio ?? 0.2))

    const exp = Math.max(0, Math.floor(attempt) - 1)
    const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exp))
    if (raw <= 0) return 0

    if (jitterRatio <= 0) return Math.floor(raw)

    const factor = (1 - jitterRatio) + (random() * 2 * jitterRatio)
    return Math.max(0, Math.floor(raw * factor))
}

export async function sleepMs(ms: number): Promise<void> {
    const delay = Math.max(0, Math.floor(ms))
    if (!delay) return
    await new Promise<void>(resolve => setTimeout(resolve, delay))
}

