import type { Table } from 'dexie'
import type { ClientPlugin, PluginContext, RegisterOperationMiddleware } from 'atoma-types/client/plugins'
import { IndexedDbOperationClient } from './operation-client'
import type { IndexedDbBackendPluginOptions } from './types'

export function indexedDbBackendPlugin(options: IndexedDbBackendPluginOptions): ClientPlugin {
    return {
        id: 'indexeddb',
        operations: (_ctx: PluginContext, register: RegisterOperationMiddleware) => {
            const operationClient = new IndexedDbOperationClient({
                tableForResource: (resource) => {
                    const tbl = (options.tables as any)[resource]
                    if (tbl) return tbl as Table<any, string>
                    throw new Error(`[Atoma] indexeddb: 未知 resource: ${String(resource)}`)
                }
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
