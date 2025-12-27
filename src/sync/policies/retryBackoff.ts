import type { SyncBackoffConfig, SyncRetryConfig } from '../types'
import { computeBackoffDelayMs } from './backoffPolicy'

export type RetryBackoffResult = {
    attempt: number
    delayMs: number
    stop: boolean
}

export class RetryBackoff {
    private attempt = 0

    constructor(private readonly config: {
        retry?: SyncRetryConfig
        backoff?: SyncBackoffConfig
        baseDelayMs?: number
    }) {}

    reset() {
        this.attempt = 0
    }

    next(): RetryBackoffResult {
        this.attempt += 1

        const maxAttempts = this.config.retry?.maxAttempts
        if (maxAttempts !== undefined && this.attempt >= Math.max(1, Math.floor(maxAttempts))) {
            return { attempt: this.attempt, delayMs: 0, stop: true }
        }

        const baseDelayMs = this.config.baseDelayMs
        const backoff = baseDelayMs === undefined
            ? this.config.backoff
            : { baseDelayMs, ...(this.config.backoff ?? {}) }
        const delayMs = computeBackoffDelayMs(this.attempt, backoff)
        return { attempt: this.attempt, delayMs, stop: false }
    }
}

