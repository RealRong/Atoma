import type { Meta, Operation, OperationResult } from '../protocol'

export type ExecuteOpsInput = {
    ops: Operation[]
    meta: Meta
    signal?: AbortSignal
}

export type ExecuteOpsOutput = {
    results: OperationResult[]
    status?: number
}

export type OperationEnvelope = Readonly<ExecuteOpsInput & {
    target?: string
}>

export type ResultEnvelope = Readonly<ExecuteOpsOutput>

export type OpsClientLike = Readonly<{
    executeOps: (input: ExecuteOpsInput) => Promise<ExecuteOpsOutput>
}>
