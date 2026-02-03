import type { Driver, Endpoint } from 'atoma-types/client'
import { MemoryOpsClient } from './MemoryOpsClient'

export type CreateMemoryEndpointOptions = Readonly<{
    id?: string
    role?: string
    seed?: Record<string, any[]>
}>

export function createMemoryEndpoint(options?: CreateMemoryEndpointOptions): Endpoint {
    const id = (typeof options?.id === 'string' && options.id.trim()) ? options.id.trim() : 'memory'
    const role = (typeof options?.role === 'string' && options.role.trim()) ? options.role.trim() : 'ops'

    const opsClient = new MemoryOpsClient({
        ...(options?.seed ? { seed: options.seed } : {})
    })

    const driver: Driver = {
        executeOps: async (req) => {
            return await opsClient.executeOps({
                ops: req.ops,
                meta: req.meta,
                ...(req.signal ? { signal: req.signal } : {}),
                ...(req.context ? { context: req.context } : {})
            })
        }
    }

    return {
        id,
        role,
        driver
    }
}
