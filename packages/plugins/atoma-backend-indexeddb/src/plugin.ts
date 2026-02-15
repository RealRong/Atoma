import type { Table } from 'dexie'
import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import { buildOperationExecutor } from 'atoma-backend-shared'
import { IndexedDbOperationClient } from './operation-client'
import type { IndexedDbBackendPluginOptions } from './types'

const INDEXEDDB_EXECUTOR_ID = 'backend.indexeddb.operation'
const INDEXEDDB_ROUTE_ID = 'direct-indexeddb'

function safeDispose(dispose?: () => void): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

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

            const unregisterService = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)
            let unregisterRoute: (() => void) | undefined

            try {
                unregisterRoute = ctx.runtime.execution.apply({
                    id: 'backend.indexeddb.route',
                    executors: {
                        [INDEXEDDB_EXECUTOR_ID]: buildOperationExecutor({
                            runtime: {
                                now: ctx.runtime.now
                            },
                            operationClient
                        })
                    },
                    routes: {
                        [INDEXEDDB_ROUTE_ID]: {
                            query: INDEXEDDB_EXECUTOR_ID,
                            write: INDEXEDDB_EXECUTOR_ID
                        }
                    },
                    defaultRoute: INDEXEDDB_ROUTE_ID
                })
            } catch (error) {
                safeDispose(unregisterService)
                throw error
            }

            return {
                dispose: () => {
                    safeDispose(unregisterRoute)
                    safeDispose(unregisterService)
                }
            }
        }
    }
}
