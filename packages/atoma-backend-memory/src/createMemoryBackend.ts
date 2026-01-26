import type { Backend, BackendEndpoint } from 'atoma/backend'
import { MemoryOpsClient } from './MemoryOpsClient'

export type CreateMemoryBackendOptions = Readonly<{
    key?: string
    seed?: Record<string, any[]>
}>

export function createMemoryBackend(options?: CreateMemoryBackendOptions): Backend {
    const key = (typeof options?.key === 'string' && options.key.trim()) ? options.key.trim() : 'memory'

    const endpoint: BackendEndpoint = {
        opsClient: new MemoryOpsClient({
            ...(options?.seed ? { seed: options.seed } : {})
        })
    }

    return {
        key,
        store: endpoint,
        capabilities: {
            storePersistence: 'ephemeral'
        }
    }
}

