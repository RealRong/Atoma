import { createId } from 'atoma-shared'

function defaultReplicaId(now: () => number): string {
    return createId({
        kind: 'replica',
        sortable: true,
        now
    })
}

const REPLICA_ID_STORAGE_KEY = 'atoma-sync:replicaId'
let cachedReplicaId: string | null = null

/**
 * Global replica identity for this browser profile / installation.
 * - Not user-configurable.
 * - Stable across reloads when localStorage is available.
 */
export function getOrCreateGlobalReplicaId(args?: { now?: () => number }): string {
    if (cachedReplicaId) return cachedReplicaId

    const now = args?.now ?? (() => Date.now())

    const ls: any = (globalThis as any)?.localStorage
    if (ls && typeof ls.getItem === 'function') {
        try {
            const existing = ls.getItem(REPLICA_ID_STORAGE_KEY)
            if (typeof existing === 'string' && existing.trim()) {
                cachedReplicaId = existing.trim()
                return cachedReplicaId
            }
        } catch {
            // ignore
        }
        const next = defaultReplicaId(now)
        try {
            ls.setItem(REPLICA_ID_STORAGE_KEY, next)
        } catch {
            // ignore
        }
        cachedReplicaId = next
        return cachedReplicaId
    }

    // Non-browser (or no localStorage): keep it stable for this process.
    cachedReplicaId = defaultReplicaId(now)
    return cachedReplicaId
}

