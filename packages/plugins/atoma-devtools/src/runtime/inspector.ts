import type { DebugPayload } from 'atoma-types/devtools'
import type {
    DevtoolsClientInspector,
    DevtoolsClientSnapshot,
    DevtoolsHistorySnapshot,
    DevtoolsIndexManagerSnapshot,
    DevtoolsStoreSnapshot,
    DevtoolsSyncSnapshot
} from './types'
import type { ClientEntry } from './registry'

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const toStringValue = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized || undefined
}

const toNumberValue = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || Number.isNaN(value)) return undefined
    return value
}

const toBooleanValue = (value: unknown): boolean | undefined => {
    if (typeof value !== 'boolean') return undefined
    return value
}

const snapshotStore = (payload: DebugPayload): DevtoolsStoreSnapshot | undefined => {
    if (payload.kind !== 'store') return undefined
    const data = isObject(payload.data) ? payload.data : {}
    const storeName = toStringValue(data.name) ?? payload.scope?.storeName
    if (!storeName) return undefined

    const sample = Array.isArray(data.sample) ? data.sample : []

    return {
        clientId: payload.clientId,
        name: storeName,
        count: toNumberValue(data.count) ?? 0,
        approxSize: toNumberValue(data.approxSize) ?? 0,
        sample,
        timestamp: toNumberValue(payload.timestamp) ?? Date.now()
    }
}

const snapshotIndex = (payload: DebugPayload): DevtoolsIndexManagerSnapshot | undefined => {
    if (payload.kind !== 'index') return undefined
    const data = isObject(payload.data) ? payload.data : {}
    const storeName = toStringValue(data.name) ?? payload.scope?.storeName
    if (!storeName) return undefined

    const indexesRaw = Array.isArray(data.indexes) ? data.indexes : []
    const indexes = indexesRaw
        .map((item) => {
            if (!isObject(item)) return undefined
            const field = toStringValue(item.field)
            const type = toStringValue(item.type)
            if (!field || !type) return undefined

            return {
                field,
                type,
                ...(typeof item.dirty === 'boolean' ? { dirty: item.dirty } : {}),
                ...(typeof item.size === 'number' ? { size: item.size } : {}),
                ...(typeof item.distinctValues === 'number' ? { distinctValues: item.distinctValues } : {}),
                ...(typeof item.avgSetSize === 'number' ? { avgSetSize: item.avgSetSize } : {}),
                ...(typeof item.maxSetSize === 'number' ? { maxSetSize: item.maxSetSize } : {}),
                ...(typeof item.minSetSize === 'number' ? { minSetSize: item.minSetSize } : {})
            }
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))

    const lastQuery = isObject(data.lastQuery) ? data.lastQuery : undefined

    return {
        clientId: payload.clientId,
        name: storeName,
        indexes,
        ...(lastQuery ? { lastQuery: lastQuery as DevtoolsIndexManagerSnapshot['lastQuery'] } : {})
    }
}

const snapshotSync = (payloads: DebugPayload[]): DevtoolsSyncSnapshot | undefined => {
    const payload = payloads.find(item => item.kind === 'sync')
    if (!payload) return undefined

    const data = isObject(payload.data) ? payload.data : {}
    const status = isObject(data.status) ? data.status : {}
    const queue = isObject(data.queue) ? data.queue : undefined

    return {
        status: {
            configured: toBooleanValue(status.configured) ?? false,
            started: toBooleanValue(status.started) ?? false
        },
        ...(queue
            ? {
                queue: {
                    ...(typeof queue.pending === 'number' ? { pending: queue.pending } : {}),
                    ...(typeof queue.failed === 'number' ? { failed: queue.failed } : {}),
                    ...(typeof queue.inFlight === 'number' ? { inFlight: queue.inFlight } : {}),
                    ...(typeof queue.total === 'number' ? { total: queue.total } : {})
                }
            }
            : {}),
        ...(typeof data.lastEventAt === 'number' ? { lastEventAt: data.lastEventAt } : {}),
        ...(typeof data.lastError === 'string' ? { lastError: data.lastError } : {})
    }
}

const snapshotHistory = (payloads: DebugPayload[]): DevtoolsHistorySnapshot => {
    const payload = payloads.find(item => item.kind === 'history')
    if (!payload) {
        return { scopes: [] }
    }

    const data = isObject(payload.data) ? payload.data : {}
    const scopes = Array.isArray(data.scopes)
        ? data.scopes
            .map((item) => {
                if (!isObject(item)) return undefined
                const scope = toStringValue(item.scope)
                if (!scope) return undefined
                return {
                    scope,
                    canUndo: toBooleanValue(item.canUndo) ?? false,
                    canRedo: toBooleanValue(item.canRedo) ?? false
                }
            })
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
        : []

    return { scopes }
}

function buildSnapshot(entry: ClientEntry): DevtoolsClientSnapshot {
    const payloads = entry.hub.snapshotAll({ clientId: entry.id })

    const stores = payloads
        .map(snapshotStore)
        .filter((item): item is DevtoolsStoreSnapshot => Boolean(item))
        .sort((left, right) => left.name.localeCompare(right.name))

    const indexes = payloads
        .map(snapshotIndex)
        .filter((item): item is DevtoolsIndexManagerSnapshot => Boolean(item))
        .sort((left, right) => left.name.localeCompare(right.name))

    return {
        id: entry.id,
        label: entry.label,
        createdAt: entry.createdAt,
        updatedAt: Date.now(),
        stores,
        indexes,
        ...(snapshotSync(payloads) ? { sync: snapshotSync(payloads) } : {}),
        history: snapshotHistory(payloads)
    }
}

export function inspectorForEntry(entry: ClientEntry): DevtoolsClientInspector {
    const snapshot = (): DevtoolsClientSnapshot => {
        entry.lastSeenAt = Date.now()
        return buildSnapshot(entry)
    }

    return {
        id: entry.id,
        label: entry.label,
        snapshot,
        subscribe: (fn) => {
            return entry.hub.subscribe((event) => {
                if (event.clientId !== entry.id) return
                fn({
                    type: `${event.type}:${event.kind}`,
                    payload: event
                })
            })
        },
        stores: {
            list: () => {
                return snapshot().stores.map(store => ({ name: store.name }))
            },
            snapshot: (name?: string) => {
                const stores = snapshot().stores
                if (!name) return stores
                return stores.filter(store => store.name === String(name))
            }
        },
        indexes: {
            list: () => {
                return snapshot().indexes.map(index => ({ name: index.name }))
            },
            snapshot: (name?: string) => {
                const indexes = snapshot().indexes
                if (!name) return indexes
                return indexes.filter(index => index.name === String(name))
            }
        },
        sync: {
            snapshot: () => {
                return snapshot().sync
            }
        },
        history: {
            snapshot: () => {
                return snapshot().history
            }
        }
    }
}
