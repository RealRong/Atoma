import type { ClientPlugin, PluginContext, ReadRequest, Register } from 'atoma-types/client'
import type { PersistResult } from 'atoma-types/runtime'
import { persistViaOps, queryViaOps } from 'atoma-backend-shared'
import { MemoryOpsClient } from './ops-client'
import type { MemoryBackendPluginOptions } from './types'

export function memoryBackendPlugin(options?: MemoryBackendPluginOptions): ClientPlugin {
    return {
        id: 'memory',
        register: (ctx: PluginContext, register: Register) => {
            const opsClient = new MemoryOpsClient({
                ...(options?.seed ? { seed: options.seed } : {})
            })

            register('io', async (req) => {
                return await opsClient.executeOps({
                    ops: req.ops,
                    meta: req.meta,
                    ...(req.signal ? { signal: req.signal } : {})
                })
            }, { priority: 1000 })

            register('read', async (req: ReadRequest) => {
                return await queryViaOps(ctx, req)
            }, { priority: 1000 })

            register('persist', async (req, _ctx, _next): Promise<PersistResult<any>> => {
                return await persistViaOps(ctx, req)
            }, { priority: 1000 })
        }
    }
}
