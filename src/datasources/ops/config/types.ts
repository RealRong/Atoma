import type { FindManyOptions, PageInfo, StoreKey } from '#core'
import type { OpsClient } from '#backend'
import type { BatchEngine } from '#batch'

export interface QueryConfig<T> {
    customFn?: (options: FindManyOptions<T>) => Promise<{ data: T[]; pageInfo?: PageInfo }>
}

export interface BatchQueryConfig {
    enabled?: boolean
    endpoint?: string
    maxBatchSize?: number
    flushIntervalMs?: number
    devWarnings?: boolean
}

export interface OpsDataSourceConfig<T> {
    opsClient: OpsClient
    resourceName: string
    /** Optional adapter name (for logging/observability). */
    name?: string
    query?: QueryConfig<T>
    batch?: boolean | BatchQueryConfig
    /**
     * Optional shared batch engine (recommended): owned by the caller (e.g. per backend/client instance).
     * When provided, OpsDataSource will use it and will NOT dispose it.
     */
    batchEngine?: BatchEngine
}
