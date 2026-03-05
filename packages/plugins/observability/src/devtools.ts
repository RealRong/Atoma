import type { Hub, Snapshot, SnapshotQuery, Source, StreamEvent } from '@atoma-js/types/devtools'
import type { DebugEvent } from '@atoma-js/types/observability'

type TraceRecord = {
    storeName: string
    event: DebugEvent
}

const resolveLimit = (query?: SnapshotQuery): number => {
    const value = typeof query?.limit === 'number' ? Math.floor(query.limit) : 100
    if (value < 1) return 1
    if (value > 200) return 200
    return value
}

export class Devtools {
    private readonly clientId: string
    private readonly now: () => number
    private readonly sourceId: string
    private readonly maxEvents: number
    private readonly records: TraceRecord[] = []
    private readonly subscribers = new Set<(event: StreamEvent) => void>()
    private readonly unregisterSource: (() => void) | undefined
    private revisionValue = 0

    constructor({ clientId, now, sourceId, maxEvents, hub }: Readonly<{
        clientId: string
        now: () => number
        sourceId: string
        maxEvents?: number
        hub?: Hub
    }>
    ) {
        this.clientId = clientId
        this.now = now
        this.sourceId = sourceId
        this.maxEvents = Math.max(1, Math.floor(maxEvents ?? 1000))

        const source: Source = {
            spec: {
                id: this.sourceId,
                clientId: this.clientId,
                namespace: 'obs.trace',
                title: 'Trace',
                priority: 60,
                panels: [
                    { id: 'trace', title: 'Trace', order: 60, renderer: 'timeline' },
                    { id: 'timeline', title: 'Timeline', order: 80, renderer: 'timeline' },
                    { id: 'raw', title: 'Raw', order: 999, renderer: 'raw' }
                ],
                capability: {
                    snapshot: true,
                    stream: true
                },
                tags: ['plugin', 'observability']
            },
            snapshot: (query) => {
                return this.snapshot(query)
            },
            subscribe: (fn) => {
                this.subscribers.add(fn)
                return () => {
                    this.subscribers.delete(fn)
                }
            }
        }

        this.unregisterSource = hub?.register(source)
    }

    publish(record: TraceRecord): void {
        this.records.push({
            storeName: record.storeName,
            event: record.event
        })

        if (this.records.length > this.maxEvents) {
            this.records.splice(0, this.records.length - this.maxEvents)
        }

        this.revisionValue += 1
        const revision = this.revisionValue
        const timestamp = this.now()

        this.emitPanelEvent({
            panelId: 'trace',
            type: 'data:changed',
            revision,
            timestamp
        })

        this.emitPanelEvent({
            panelId: 'timeline',
            type: 'timeline:event',
            revision,
            timestamp,
            payload: record
        })
    }

    dispose(): void {
        this.subscribers.clear()
        try {
            this.unregisterSource?.()
        } catch {
            // ignore
        }
    }

    private snapshot(query?: SnapshotQuery): Snapshot {
        const limit = resolveLimit(query)
        const storeName = typeof query?.storeName === 'string' ? query.storeName : undefined
        const items: Array<{ storeName: string } & DebugEvent> = []

        for (let index = this.records.length - 1; index >= 0; index -= 1) {
            const record = this.records[index]
            if (storeName && record.storeName !== storeName) continue

            items.push({
                storeName: record.storeName,
                ...record.event
            })

            if (items.length >= limit) break
        }

        return {
            version: 1,
            sourceId: this.sourceId,
            clientId: this.clientId,
            panelId: query?.panelId ?? 'trace',
            revision: this.revisionValue,
            timestamp: this.now(),
            data: {
                items
            }
        }
    }

    private emitPanelEvent(args: {
        panelId?: StreamEvent['panelId']
        type: StreamEvent['type']
        revision?: number
        timestamp: number
        payload?: unknown
    }) {
        const event: StreamEvent = {
            version: 1,
            sourceId: this.sourceId,
            clientId: this.clientId,
            panelId: args.panelId,
            type: args.type,
            revision: args.revision,
            timestamp: args.timestamp,
            ...(args.payload === undefined ? {} : { payload: args.payload })
        }

        this.subscribers.forEach((subscriber) => {
            try {
                subscriber(event)
            } catch {
                // ignore
            }
        })
    }
}
