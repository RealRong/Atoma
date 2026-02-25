import type { Snapshot, SnapshotQuery } from 'atoma-types/devtools'
import type { DebugEvent } from 'atoma-types/observability'

export type TraceEntry = Readonly<{
    storeName: string
    event: DebugEvent
}>

type TraceRecord = {
    storeName: string
    event: DebugEvent
    searchText: string
}

const parseCursor = (cursor?: string): number => {
    if (typeof cursor !== 'string') return 0
    const parsed = Number.parseInt(cursor, 10)
    if (Number.isNaN(parsed) || parsed < 0) return 0
    return parsed
}

const resolveLimit = (query?: SnapshotQuery): number => {
    const value = typeof query?.limit === 'number' ? Math.floor(query.limit) : 100
    if (value < 1) return 1
    if (value > 1000) return 1000
    return value
}

const resolveFilterValue = (query: SnapshotQuery | undefined, key: string): string | undefined => {
    const value = query?.filter?.[key]
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized || undefined
}

const normalizeSearchText = (entry: TraceEntry): string => {
    try {
        const serialized = JSON.stringify(entry)
        return typeof serialized === 'string' ? serialized.toLowerCase() : ''
    } catch {
        return ''
    }
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
            event: entry.event,
            searchText: normalizeSearchText(entry)
        })
        if (this.records.length > this.maxEvents) {
            this.records.splice(0, this.records.length - this.maxEvents)
        }
        this.revisionValue += 1
        return this.revisionValue
    }

    revision(): number {
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

        const storeName = typeof query?.storeName === 'string' ? query.storeName : undefined
        const traceId = resolveFilterValue(query, 'traceId')
        const requestId = resolveFilterValue(query, 'requestId')
        const eventType = resolveFilterValue(query, 'type')
        const scope = resolveFilterValue(query, 'scope')
        const search = typeof query?.search === 'string' ? query.search.trim().toLowerCase() : ''

        const cursor = parseCursor(query?.cursor)
        const limit = resolveLimit(query)
        const nextCursor = cursor + limit

        const items: Array<{ storeName: string } & DebugEvent> = []
        let matchedCount = 0

        for (let index = this.records.length - 1; index >= 0; index -= 1) {
            const record = this.records[index]
            if (storeName && record.storeName !== storeName) continue
            if (traceId && record.event.traceId !== traceId) continue
            if (requestId && record.event.requestId !== requestId) continue
            if (eventType && record.event.type !== eventType) continue
            if (scope && record.event.scope !== scope) continue
            if (search && !record.searchText.includes(search)) continue

            if (matchedCount >= cursor && matchedCount < nextCursor) {
                items.push({
                    storeName: record.storeName,
                    ...record.event
                })
            }
            matchedCount += 1
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
            },
            page: {
                cursor: String(cursor),
                nextCursor: nextCursor < matchedCount ? String(nextCursor) : undefined,
                totalApprox: matchedCount
            }
        }
    }
}
