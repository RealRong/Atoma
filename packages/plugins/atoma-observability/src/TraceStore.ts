import type { Snapshot, SnapshotQuery } from 'atoma-types/devtools'
import type { DebugEvent } from 'atoma-types/observability'

export type TraceEntry = Readonly<{
    storeName: string
    event: DebugEvent
}>

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

export class TraceStore {
    private readonly records: TraceRecord[] = []
    private readonly maxEvents: number
    private revisionValue = 0

    constructor(args: { maxEvents?: number } = {}) {
        const maxEvents = typeof args.maxEvents === 'number' ? Math.floor(args.maxEvents) : 1000
        this.maxEvents = Math.max(1, maxEvents)
    }

    record(entry: TraceEntry): number {
        this.records.push({
            storeName: entry.storeName,
            event: entry.event
        })

        if (this.records.length > this.maxEvents) {
            this.records.splice(0, this.records.length - this.maxEvents)
        }

        this.revisionValue += 1
        return this.revisionValue
    }

    snapshot(args: {
        sourceId: string
        clientId: string
        now: number
        query?: SnapshotQuery
        defaultPanelId?: string
    }): Snapshot {
        const { sourceId, clientId, now, query } = args
        const defaultPanelId = args.defaultPanelId ?? 'trace'

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
            sourceId,
            clientId,
            panelId: query?.panelId ?? defaultPanelId,
            revision: this.revisionValue,
            timestamp: now,
            data: {
                items
            }
        }
    }
}
