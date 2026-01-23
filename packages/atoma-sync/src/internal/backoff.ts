import type { SyncBackoffConfig, SyncRetryConfig } from '#sync/types'

export type RetryBackoff = Readonly<{
    maxAttempts: number
    factor: number
    baseDelayMs: number
    maxDelayMs: number
    jitterRatio: number
}>

export function resolveRetryBackoff(args: {
    retry?: SyncRetryConfig
    backoff?: SyncBackoffConfig
    baseDelayMs?: number
}): RetryBackoff {
    const maxAttempts = args.retry?.maxAttempts
    const resolvedMaxAttempts = maxAttempts === undefined ? 10 : Math.max(0, Math.floor(maxAttempts))

    const baseDelayMs = Math.max(0, Math.floor(args.baseDelayMs ?? args.backoff?.baseDelayMs ?? 300))
    const maxDelayMs = Math.max(baseDelayMs, Math.floor(args.backoff?.maxDelayMs ?? 30_000))
    const jitterRatio = args.backoff?.jitterRatio ?? 0.2

    return {
        maxAttempts: resolvedMaxAttempts,
        factor: 2,
        baseDelayMs,
        maxDelayMs,
        jitterRatio
    }
}

export function computeBackoffDelayMs(cfg: RetryBackoff, attemptNumber: number): number {
    const attempt = Math.max(1, Math.floor(attemptNumber))
    const exp = Math.max(0, attempt - 1)

    const raw = cfg.baseDelayMs * Math.pow(cfg.factor, exp)
    const clamped = Math.max(0, Math.min(cfg.maxDelayMs, raw))

    const ratio = (typeof cfg.jitterRatio === 'number' && Number.isFinite(cfg.jitterRatio))
        ? Math.max(0, Math.min(1, cfg.jitterRatio))
        : 0

    if (!ratio) return Math.floor(clamped)

    const delta = clamped * ratio
    const min = clamped - delta
    const max = clamped + delta
    const jittered = min + (max - min) * Math.random()
    return Math.max(0, Math.floor(Math.min(cfg.maxDelayMs, jittered)))
}

