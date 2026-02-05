import type { Table } from 'dexie'

export type IndexedDbBackendPluginOptions = Readonly<{
    tables: Record<string, Table<any, string>>
}>
