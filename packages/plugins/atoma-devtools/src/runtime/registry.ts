import type { DebugHub } from 'atoma-types/devtools'

export type ClientEntry = {
    id: string
    label?: string
    createdAt: number
    lastSeenAt: number
    hub: DebugHub
}

const byId = new Map<string, ClientEntry>()

export function listEntries(): ClientEntry[] {
    return Array.from(byId.values())
}

export function getEntryById(id: string): ClientEntry | undefined {
    return byId.get(String(id))
}

export function removeEntryById(id: string): void {
    byId.delete(String(id))
}

export function ensureEntry(args: {
    clientId: string
    label?: string
    hub: DebugHub
}): ClientEntry {
    const stableId = String(args.clientId)
    const now = Date.now()

    const existing = byId.get(stableId)
    if (existing) {
        existing.lastSeenAt = now
        if (args.label) existing.label = String(args.label)
        existing.hub = args.hub
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
    return entry
}
