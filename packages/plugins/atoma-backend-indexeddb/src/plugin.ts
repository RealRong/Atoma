import type { Table } from 'dexie'
import type { ClientPlugin, PluginContext, OpsRegister } from 'atoma-types/client/plugins'
import { IndexedDBOpsClient } from './ops-client'
import type { IndexedDbBackendPluginOptions } from './types'

export function indexedDbBackendPlugin(options: IndexedDbBackendPluginOptions): ClientPlugin {
    return {
        id: 'indexeddb',
        register: (_ctx: PluginContext, register: OpsRegister) => {
            const opsClient = new IndexedDBOpsClient({
                tableForResource: (resource) => {
                    const tbl = (options.tables as any)[resource]
                    if (tbl) return tbl as Table<any, string>
                    throw new Error(`[Atoma] indexeddb: 未知 resource: ${String(resource)}`)
                }
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
