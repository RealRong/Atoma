import type { Hub, Source, StreamEvent } from 'atoma-types/devtools'
import type { EventExporter, ExportEvent } from './types'
import { TraceStore } from '../storage/TraceStore'

const emitSafely = (subscriber: (event: StreamEvent) => void, event: StreamEvent) => {
    try {
        subscriber(event)
    } catch {
        // ignore
    }
}

export type DevtoolsExporterArgs = Readonly<{
    clientId: string
    runtimeNow: () => number
    traceStore: TraceStore
    sourceId: string
    hub?: Hub
}>

export class DevtoolsExporter implements EventExporter {
    private readonly clientId: string
    private readonly runtimeNow: () => number
    private readonly traceStore: TraceStore
    private readonly sourceId: string
    private readonly subscribers = new Set<(event: StreamEvent) => void>()
    private readonly unregisterSource: (() => void) | undefined

    constructor(args: DevtoolsExporterArgs) {
        this.clientId = args.clientId
        this.runtimeNow = args.runtimeNow
        this.traceStore = args.traceStore
        this.sourceId = args.sourceId

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
                    stream: true,
                    search: true,
                    paginate: true
                },
                tags: ['plugin', 'observability']
            },
            snapshot: (query) => {
                return this.traceStore.snapshot({
                    sourceId: this.sourceId,
                    clientId: this.clientId,
                    now: this.runtimeNow(),
                    query,
                    defaultPanelId: 'trace'
                })
            },
            subscribe: (fn) => {
                this.subscribers.add(fn)
                return () => {
                    this.subscribers.delete(fn)
                }
            }
        }

        this.unregisterSource = args.hub?.register(source)
    }

    publish(entry: ExportEvent): void {
        const revision = this.traceStore.record(entry)
        const timestamp = this.runtimeNow()

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
            payload: entry
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
            emitSafely(subscriber, event)
        })
    }
}
