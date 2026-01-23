import type { SyncEvent, SyncOutboxStats, SyncPhase } from '#sync/types'

type DevtoolsSubscriber = (e: any) => void

export class SyncDevtools {
    private readonly subscribers = new Set<DevtoolsSubscriber>()

    private lastEventAt: number | undefined
    private lastError: string | undefined
    private lastOutboxStats: SyncOutboxStats | undefined
    private started = false

    constructor(private readonly deps: { now: () => number }) {}

    onEvent = (e: SyncEvent) => {
        this.lastEventAt = this.deps.now()
        if ((e as any)?.type === 'outbox:queue') this.lastOutboxStats = (e as any).stats
        if ((e as any)?.type === 'outbox:queue_full') this.lastOutboxStats = (e as any).stats
        if ((e as any)?.type === 'lifecycle:started') this.started = true
        if ((e as any)?.type === 'lifecycle:stopped') this.started = false

        this.emit({ type: String((e as any)?.type ?? 'event'), payload: e })
    }

    onError = (error: Error, context: { phase: SyncPhase }) => {
        this.lastError = error?.message ? String(error.message) : 'Unknown error'
        this.emit({ type: 'error', payload: { error: this.lastError, context } })
    }

    getStarted = () => this.started

    snapshot = () => ({
        status: { configured: true, started: this.started },
        ...(this.lastOutboxStats ? { queue: { pending: this.lastOutboxStats.pending, inFlight: this.lastOutboxStats.inFlight, total: this.lastOutboxStats.total } } : {}),
        lastEventAt: this.lastEventAt,
        lastError: this.lastError
    })

    subscribe = (fn: DevtoolsSubscriber) => {
        this.subscribers.add(fn)
        return () => {
            this.subscribers.delete(fn)
        }
    }

    private emit(e: any) {
        for (const fn of this.subscribers) {
            try {
                fn(e)
            } catch {
                // ignore
            }
        }
    }
}

