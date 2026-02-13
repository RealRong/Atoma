import type { ClientPlugin, PluginContext, RegisterOperationMiddleware } from 'atoma-types/client/plugins'
import { MemoryOperationClient } from './operation-client'
import type { MemoryBackendPluginOptions } from './types'

export function memoryBackendPlugin(options?: MemoryBackendPluginOptions): ClientPlugin {
    return {
        id: 'memory',
        operations: (_ctx: PluginContext, register: RegisterOperationMiddleware) => {
            const operationClient = new MemoryOperationClient({
                ...(options?.seed ? { seed: options.seed } : {})
            })

            register(async (req) => {
                return await operationClient.executeOperations({
                    ops: req.ops,
                    meta: req.meta,
                    ...(req.signal ? { signal: req.signal } : {})
                })
            }, { priority: 1000 })
        }
    }
}
