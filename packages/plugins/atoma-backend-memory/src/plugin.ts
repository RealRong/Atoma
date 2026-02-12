import type { ClientPlugin, PluginContext, OpsRegister } from 'atoma-types/client/plugins'
import { MemoryOpsClient } from './ops-client'
import type { MemoryBackendPluginOptions } from './types'

export function memoryBackendPlugin(options?: MemoryBackendPluginOptions): ClientPlugin {
    return {
        id: 'memory',
        register: (_ctx: PluginContext, register: OpsRegister) => {
            const opsClient = new MemoryOpsClient({
                ...(options?.seed ? { seed: options.seed } : {})
            })

            register(async (req) => {
                return await opsClient.executeOps({
                    ops: req.ops,
                    meta: req.meta,
                    ...(req.signal ? { signal: req.signal } : {})
                })
            }, { priority: 1000 })
        }
    }
}
