import { OpsClient } from './OpsClient'
import { HttpOpsClient } from './http/HttpOpsClient'
import { Batch } from './batch'

export const Ops = {
    OpsClient,
    HttpOpsClient,
    Batch
} as const

export type { OpsClient, ExecuteOpsInput, ExecuteOpsOutput } from './OpsClient'
export type { HttpOpsClientConfig } from './http/HttpOpsClient'
export type { RetryOptions } from './http/transport/retryPolicy'
export type { BatchEngine, BatchEngineConfig } from './batch'
