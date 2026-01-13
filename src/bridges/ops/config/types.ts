import type { OpsClient } from '#backend'

export interface OpsDataSourceConfig<T> {
    opsClient: OpsClient
    resourceName: string
    /** Optional adapter name (for logging/observability). */
    name?: string
}
