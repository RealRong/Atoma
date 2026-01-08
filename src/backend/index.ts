import { OpsClient } from './OpsClient'
import { HttpOpsClient } from './http/HttpOpsClient'
import { IndexedDBOpsClient } from './local/IndexedDBOpsClient'
import { MemoryOpsClient } from './local/MemoryOpsClient'

export const Backend = {
    OpsClient,
    HttpOpsClient,
    IndexedDBOpsClient,
    MemoryOpsClient
}

export type { OpsClient, ExecuteOpsInput, ExecuteOpsOutput } from './OpsClient'
export type { HttpOpsClientConfig } from './http/HttpOpsClient'
export type { RetryOptions } from './http/transport/retryPolicy'
