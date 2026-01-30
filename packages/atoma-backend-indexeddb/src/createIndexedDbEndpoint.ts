import type { Table } from 'dexie'
import type { Driver, Endpoint } from 'atoma/backend'
import { IndexedDBOpsClient } from './IndexedDBOpsClient'

export type CreateIndexedDbEndpointOptions = Readonly<{
    id?: string
    role?: string
    tables: Record<string, Table<any, string>>
}>

export function createIndexedDbEndpoint(options: CreateIndexedDbEndpointOptions): Endpoint {
    const id = (typeof options.id === 'string' && options.id.trim()) ? options.id.trim() : 'indexeddb'
    const role = (typeof options.role === 'string' && options.role.trim()) ? options.role.trim() : 'ops'

    const opsClient = new IndexedDBOpsClient({
        tableForResource: (resource) => {
            const tbl = (options.tables as any)[resource]
            if (tbl) return tbl as Table<any, string>
            throw new Error(`[Atoma] indexeddb: 未知 resource: ${String(resource)}`)
        }
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
