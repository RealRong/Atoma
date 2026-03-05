import type { SyncEvent, SyncPhase } from 'atoma-types/sync'

type DevtoolsSubscriber = (e: any) => void

export class SyncDevtools {
    private readonly subscribers = new Set<DevtoolsSubscriber>()

    private lastEventAt: number | undefined
    private lastError: string | undefined
    private readonly resourceStats = new Map<string, {
        sent: number
        received: number
        conflicts: number
        lastCursor?: number
    }>()
    private started = false

    constructor(private readonly deps: { now: () => number }) {}

    onEvent = (e: SyncEvent) => {
        this.lastEventAt = this.deps.now()
        this.trackEvent(e)

        this.emit({ type: String((e as any)?.type ?? 'event'), payload: e })
    }

    onError = (error: Error, context: { phase: SyncPhase }) => {
        this.lastError = error?.message ? String(error.message) : 'Unknown error'
        this.emit({ type: 'error', payload: { error: this.lastError, context } })
    }

    getStarted = () => this.started

    snapshot = () => ({
        status: { configured: true, started: this.started },
        resources: Array.from(this.resourceStats.entries()).map(([resource, stats]) => ({
            resource,
            ...stats
        })),
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

    private trackEvent(e: SyncEvent) {
        if (e.type === 'sync.lifecycle.started') {
            this.started = true
            return
        }
        if (e.type === 'sync.lifecycle.stopped') {
            this.started = false
            return
        }
        if (e.type === 'sync.error') {
            this.lastError = e.message
            return
        }

        const resource = resolveResourceFromEvent(e)
        if (!resource) return

        const current = this.resourceStats.get(resource) ?? {
            sent: 0,
            received: 0,
            conflicts: 0
        }
        if (e.type === 'sync.push.batch') {
            current.sent += Math.max(0, Math.floor(e.size))
        } else if (e.type === 'sync.pull.batch') {
            current.received += Math.max(0, Math.floor(e.size))
            current.lastCursor = Math.max(0, Math.floor(e.cursor))
        } else if (e.type === 'sync.conflict.detected') {
            current.conflicts += Math.max(0, Math.floor(e.count))
        } else if (e.type === 'sync.stream.notify' && typeof e.cursor === 'number') {
            current.lastCursor = Math.max(0, Math.floor(e.cursor))
        } else if (e.type === 'sync.bridge.localWrite') {
            current.sent += Math.max(0, Math.floor(e.count))
        } else if (e.type === 'sync.bridge.remoteWriteback') {
            current.received += Math.max(0, Math.floor(e.upserts + e.removes))
        }
        this.resourceStats.set(resource, current)
    }
}

function resolveResourceFromEvent(e: SyncEvent): string | undefined {
    if ('resource' in e && typeof (e as any).resource === 'string') {
        return (e as any).resource
    }
    return undefined
}
