import type { Hub } from 'atoma-types/devtools'

export type ClientEntry = {
    id: string
    label?: string
    createdAt: number
    lastSeenAt: number
    hub: Hub
}

const byId = new Map<string, ClientEntry>()
const subscribers = new Set<() => void>()

const emit = (): void => {
    for (const subscriber of subscribers) {
        try {
            subscriber()
        } catch {
            // ignore
        }
    }
}

export function listEntries(): ClientEntry[] {
    return Array.from(byId.values())
}

export function getEntryById(id: string): ClientEntry | undefined {
    return byId.get(String(id))
}

export function removeEntryById(id: string): void {
    byId.delete(String(id))
    emit()
}

export function ensureEntry(args: {
    clientId: string
    label?: string
    hub: Hub
}): ClientEntry {
    const stableId = String(args.clientId)
    const now = Date.now()

    const existing = byId.get(stableId)
    if (existing) {
        existing.lastSeenAt = now
        if (args.label) existing.label = String(args.label)
        existing.hub = args.hub
        emit()
        return existing
    }

    const entry: ClientEntry = {
        id: stableId,
        label: args.label ? String(args.label) : undefined,
        createdAt: now,
        lastSeenAt: now,
        hub: args.hub
    }

    byId.set(stableId, entry)
    emit()
    return entry
}

export function subscribeEntries(fn: () => void): () => void {
    subscribers.add(fn)
    return () => {
        subscribers.delete(fn)
    }
}
