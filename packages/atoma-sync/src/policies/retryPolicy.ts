import type { Options, RetryContext } from 'p-retry'
import type { SyncBackoffConfig, SyncRetryConfig } from '../types'

export function resolveRetryOptions(args: {
    retry?: SyncRetryConfig
    backoff?: SyncBackoffConfig
    baseDelayMs?: number
    signal?: AbortSignal
    unref?: boolean
    onFailedAttempt?: Options['onFailedAttempt']
    shouldRetry?: Options['shouldRetry']
    shouldConsumeRetry?: Options['shouldConsumeRetry']
}): Options {
    const maxAttempts = args.retry?.maxAttempts
    const retries = maxAttempts === undefined ? 10 : Math.max(0, Math.floor(maxAttempts) - 1)

    const baseDelayMs = Math.max(0, Math.floor(args.baseDelayMs ?? args.backoff?.baseDelayMs ?? 300))
    const maxDelayMs = Math.max(baseDelayMs, Math.floor(args.backoff?.maxDelayMs ?? 30_000))
    const jitterRatio = args.backoff?.jitterRatio ?? 0.2

    return {
        retries,
        factor: 2,
        minTimeout: baseDelayMs,
        maxTimeout: maxDelayMs,
        randomize: jitterRatio > 0,
        signal: args.signal,
        unref: args.unref,
        onFailedAttempt: args.onFailedAttempt,
        shouldRetry: args.shouldRetry,
        shouldConsumeRetry: args.shouldConsumeRetry
    }
}

export function estimateRetryDelayMs(args: {
    attemptNumber: number
    factor?: number
    minTimeout?: number
    maxTimeout?: number
}): number {
    const attemptNumber = Math.max(1, Math.floor(args.attemptNumber))
    const factor = typeof args.factor === 'number' && Number.isFinite(args.factor) ? args.factor : 2
    const minTimeout = Math.max(0, Math.floor(args.minTimeout ?? 1000))
    const maxTimeout = args.maxTimeout === undefined ? Infinity : Math.max(minTimeout, Math.floor(args.maxTimeout))

    const exp = Math.max(0, attemptNumber - 1)
    const raw = minTimeout * Math.pow(factor, exp)
    const clamped = Math.min(maxTimeout, raw)
    return Math.max(0, Math.floor(clamped))
}

export function estimateDelayFromRetryContext(ctx: RetryContext, options: Pick<Options, 'factor' | 'minTimeout' | 'maxTimeout'>): number {
    return estimateRetryDelayMs({
        attemptNumber: ctx.attemptNumber,
        factor: options.factor,
        minTimeout: options.minTimeout,
        maxTimeout: options.maxTimeout
    })
}

