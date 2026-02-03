import type * as Types from '../core'
import type { Meta, Operation, OperationResult } from '../protocol'

export type ExecuteOpsInput = {
    ops: Operation[]
    meta: Meta
    signal?: AbortSignal
    context?: Types.ObservabilityContext
}

export type ExecuteOpsOutput = {
    results: OperationResult[]
    status?: number
}

export type OpsClientLike = Readonly<{
    executeOps: (input: ExecuteOpsInput) => Promise<ExecuteOpsOutput>
}>
