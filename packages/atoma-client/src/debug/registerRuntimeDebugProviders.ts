import { Runtime } from 'atoma-runtime'
import type { DebugHub } from 'atoma-types/devtools'
import { registerStoreDebugProvider } from './providers/storeProvider'
import { registerIndexDebugProvider } from './providers/indexProvider'

function safeDispose(dispose: (() => void) | undefined): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

export function registerRuntimeDebugProviders(runtime: Runtime, debugHub: DebugHub): () => void {
    const disposersById = new Map<string, () => void>()

    const stopStoreListener = runtime.stores.onCreated((store: unknown) => {
        const storeName = String((store as { name?: unknown })?.name ?? '').trim()
        if (!storeName) return

        registerStoreDebugProvider({
            runtime,
            debugHub,
            storeName,
            disposersById
        })

        registerIndexDebugProvider({
            runtime,
            debugHub,
            storeName,
            disposersById
        })
    }, { replay: true })

    return () => {
        try {
            stopStoreListener()
        } catch {
            // ignore
        }

        for (const dispose of disposersById.values()) {
            safeDispose(dispose)
        }

        disposersById.clear()
    }
}
