import { createKVStore } from '#sync/internal/kvStore'
import pRetry from 'p-retry'
import { estimateDelayFromRetryContext, resolveRetryOptions } from '#sync/policies/retryPolicy'

type LockRecord = {
    ownerId: string
    expiresAtMs: number
}

function parseLockRecord(raw: unknown): LockRecord | null {
    if (!raw || typeof raw !== 'object') return null
    const ownerId = typeof (raw as any).ownerId === 'string' ? (raw as any).ownerId : ''
    const expiresAtMs = typeof (raw as any).expiresAtMs === 'number' ? (raw as any).expiresAtMs : 0
    if (!ownerId || !expiresAtMs) return null
    return { ownerId, expiresAtMs }
}

function randomOwnerId(): string {
    const cryptoAny = typeof crypto !== 'undefined' ? (crypto as any) : undefined
    const randomUUID = cryptoAny && typeof cryptoAny.randomUUID === 'function' ? cryptoAny.randomUUID.bind(cryptoAny) : undefined
    if (randomUUID) {
        const id = randomUUID()
        if (typeof id === 'string' && id) return id
    }
    return `sync_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export class SingleInstanceLock {
    private readonly kv = createKVStore()
    private readonly ownerId = randomOwnerId()
    private held = false
    private renewTimer?: ReturnType<typeof setInterval>

    constructor(private readonly config: {
        key: string
        ttlMs: number
        renewIntervalMs: number
        now: () => number
        maxAcquireAttempts?: number
        backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        onLost?: (error: Error) => void
    }) {}

    isHeld() {
        return this.held
    }

    async acquire() {
        if (this.held) return

        const maxAttempts = Math.max(1, Math.floor(this.config.maxAcquireAttempts ?? 5))
        const retryOptions = resolveRetryOptions({
            retry: { maxAttempts },
            backoff: this.config.backoff,
            baseDelayMs: this.config.backoff?.baseDelayMs ?? 300,
            unref: true,
            shouldRetry: () => !this.held
        })

        try {
            await pRetry(async () => {
                const ok = await this.tryAcquireOnce()
                if (!ok) {
                    throw new Error('LOCK_TAKEN')
                }
            }, {
                ...retryOptions,
                onFailedAttempt: (ctx) => {
                    // No SyncEvent for lock acquire backoff today; keep the logic observable in logs if needed.
                    void estimateDelayFromRetryContext(ctx, retryOptions)
                },
                shouldRetry: async (ctx) => {
                    if (this.held) return false
                    // Retry on lock contention or transient KV errors; callers will handle final failure.
                    return ctx.error instanceof Error
                }
            })
        } catch {
            throw new Error(`[Sync] Another Sync instance is already active for lockKey="${this.config.key}"`)
        }

        this.held = true
        this.startRenew()
    }

    async release() {
        this.stopRenew()
        if (!this.held) return
        this.held = false
        await this.kv.update(this.config.key, (current) => {
            const existing = parseLockRecord(current)
            if (!existing) {
                return { result: undefined, write: false }
            }
            if (existing.ownerId !== this.ownerId) {
                return { result: undefined, write: false }
            }
            return { result: undefined, next: null, write: true }
        })
    }

    private startRenew() {
        this.stopRenew()
        const interval = Math.max(50, Math.floor(this.config.renewIntervalMs))
        this.renewTimer = setInterval(() => {
            void this.renew().catch(() => {
                // ignore, will retry next tick
            })
        }, interval)
    }

    private stopRenew() {
        if (!this.renewTimer) return
        clearInterval(this.renewTimer)
        this.renewTimer = undefined
    }

    private async renew() {
        if (!this.held) return
        const now = this.config.now()
        const ttlMs = Math.max(0, Math.floor(this.config.ttlMs))

        const ok = await this.kv.update(this.config.key, (current) => {
            const existing = parseLockRecord(current)
            if (!existing || existing.ownerId !== this.ownerId) {
                return { result: false, write: false }
            }
            const next: LockRecord = { ownerId: this.ownerId, expiresAtMs: now + ttlMs }
            return { result: true, next, write: true }
        })

        if (!ok) {
            this.held = false
            this.stopRenew()
            const error = new Error(`[Sync] Lock lost for lockKey="${this.config.key}"`)
            this.config.onLost?.(error)
            throw error
        }
    }

    private async tryAcquireOnce(): Promise<boolean> {
        const now = this.config.now()
        const ttlMs = Math.max(0, Math.floor(this.config.ttlMs))

        const claimed = await this.kv.update(this.config.key, (current) => {
            const existing = parseLockRecord(current)
            const expired = !existing || existing.expiresAtMs <= now
            if (!expired && existing.ownerId !== this.ownerId) {
                return { result: false, write: false }
            }

            const next: LockRecord = { ownerId: this.ownerId, expiresAtMs: now + ttlMs }
            return { result: true, next, write: true }
        })

        if (!claimed) return false

        // Cross-transaction race exists when multiple contenders see an expired lock.
        // Verify after commit that we still own it.
        const confirm = parseLockRecord(await this.kv.get<any>(this.config.key))
        return !!confirm && confirm.ownerId === this.ownerId
    }
}
