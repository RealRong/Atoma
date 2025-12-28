import type { FindManyOptions, PageInfo, StoreKey } from '#core'
import type { OpsClient } from '../../../backend/OpsClient'

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

export interface HttpDataSourceConfig<T> {
    opsClient: OpsClient
    resourceName: string
    /** Optional adapter name (for logging/observability). */
    name?: string
    query?: QueryConfig<T>
    batch?: boolean | BatchQueryConfig
    usePatchForUpdate?: boolean
}
