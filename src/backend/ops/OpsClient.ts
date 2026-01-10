import type { ObservabilityContext } from '#observability'
import type { Meta, Operation, OperationResult } from '#protocol'

export type ExecuteOpsInput = {
    ops: Operation[]
    meta: Meta
    signal?: AbortSignal
    context?: ObservabilityContext
}

export type ExecuteOpsOutput = {
    results: OperationResult[]
    status?: number
}

export abstract class OpsClient {
    abstract executeOps(input: ExecuteOpsInput): Promise<ExecuteOpsOutput>
}
