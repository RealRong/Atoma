import type { Table } from 'dexie'
import type { Backend, BackendEndpoint } from 'atoma/backend'
import { IndexedDBOpsClient } from './IndexedDBOpsClient'

export type CreateIndexedDbBackendOptions = Readonly<{
    /**
     * Stable identifier for this backend instance.
     * Default: 'indexeddb'
     */
    key?: string

    /** Map of `resourceName -> Dexie Table` */
    tables: Record<string, Table<any, string>>
}>

function makeTableForResource<T extends Record<string, Table<any, string>>>(
    tables: T
): (resource: string) => Table<any, string> {
    return (resource: string) => {
        const tbl = (tables as any)[resource]
        if (tbl) return tbl as Table<any, string>
        throw new Error(`[Atoma] indexeddb: 未知 resource: ${String(resource)}`)
    }
}

export function createIndexedDbBackend(options: CreateIndexedDbBackendOptions): Backend {
    const key = (typeof options.key === 'string' && options.key.trim()) ? options.key.trim() : 'indexeddb'

    const endpoint: BackendEndpoint = {
        opsClient: new IndexedDBOpsClient({
            tableForResource: makeTableForResource(options.tables)
        })
    }

    return {
        key,
        store: endpoint,
        capabilities: {
            storePersistence: 'durable'
        }
    }
}

