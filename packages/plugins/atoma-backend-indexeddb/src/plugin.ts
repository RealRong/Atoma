import type { Table } from 'dexie'
import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import { IndexedDbOperationClient } from './operation-client'
import type { IndexedDbBackendPluginOptions } from './types'

export function indexedDbBackendPlugin(options: IndexedDbBackendPluginOptions): ClientPlugin {
    return {
        id: 'indexeddb',
        provides: [OPERATION_CLIENT_TOKEN],
        setup: (ctx) => {
            const operationClient = new IndexedDbOperationClient({
                tableForResource: (resource) => {
                    const tbl = (options.tables as any)[resource]
                    if (tbl) return tbl as Table<any, string>
                    throw new Error(`[Atoma] indexeddb: 未知 resource: ${String(resource)}`)
                }
            })

            const unregister = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)

            return {
                dispose: () => {
                    try {
                        unregister?.()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
