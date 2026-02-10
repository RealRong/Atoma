import { Runtime } from 'atoma-runtime'
import type { DebugHub } from 'atoma-types/devtools'

export function registerStoreDebugProvider(args: {
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

    const providerId = `store.${runtime.id}.${storeName}`
    if (disposersById.has(providerId)) return

    const unregister = debugHub.register({
        id: providerId,
        kind: 'store',
        clientId: runtime.id,
        priority: 10,
        snapshot: () => {
            const snapshot = runtime.debug.snapshotStore(storeName)

            return {
                version: 1,
                providerId,
                kind: 'store',
                clientId: runtime.id,
                timestamp: snapshot?.timestamp ?? runtime.now(),
                scope: { storeName, tab: 'store' },
                data: snapshot ?? {
                    name: storeName,
                    count: 0,
                    approxSize: 0,
                    sample: []
                }
            }
        }
    })

    disposersById.set(providerId, unregister)
}
