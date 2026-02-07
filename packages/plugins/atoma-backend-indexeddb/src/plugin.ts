import type { Table } from 'dexie'
import type { ClientPlugin, PluginContext, ReadRequest, Register } from 'atoma-types/client'
import type { PersistResult } from 'atoma-types/runtime'
import { persistViaOps, queryViaOps } from 'atoma-backend-shared'
import { IndexedDBOpsClient } from './ops-client'
import type { IndexedDbBackendPluginOptions } from './types'

export function indexedDbBackendPlugin(options: IndexedDbBackendPluginOptions): ClientPlugin {
    return {
        id: 'indexeddb',
        register: (ctx: PluginContext, register: Register) => {
            const opsClient = new IndexedDBOpsClient({
                tableForResource: (resource) => {
                    const tbl = (options.tables as any)[resource]
                    if (tbl) return tbl as Table<any, string>
                    throw new Error(`[Atoma] indexeddb: 未知 resource: ${String(resource)}`)
                }
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
