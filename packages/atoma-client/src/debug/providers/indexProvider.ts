import { Runtime } from 'atoma-runtime'
import type { DebugHub } from 'atoma-types/devtools'

export function registerIndexDebugProvider(args: {
    runtime: Runtime
    debugHub: DebugHub
    storeName: string
    disposersById: Map<string, () => void>
}): void {
    const {
        runtime,
        debugHub,
        storeName,
        disposersById
    } = args

    const snapshot = runtime.debug.snapshotIndexes(storeName)
    if (!snapshot) return

    const providerId = `index.${runtime.id}.${storeName}`
    if (disposersById.has(providerId)) return

    const unregister = debugHub.register({
        id: providerId,
        kind: 'index',
        clientId: runtime.id,
        priority: 20,
        snapshot: () => {
            const nextSnapshot = runtime.debug.snapshotIndexes(storeName)

            return {
                version: 1,
                providerId,
                kind: 'index',
                clientId: runtime.id,
                timestamp: nextSnapshot?.timestamp ?? runtime.now(),
                scope: { storeName, tab: 'index' },
                data: nextSnapshot ?? {
                    name: storeName,
                    indexes: []
                }
            }
        }
    })

    disposersById.set(providerId, unregister)
}
