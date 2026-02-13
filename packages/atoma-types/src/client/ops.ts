import type { Meta, RemoteOp, RemoteOpResult } from '../protocol'

export type ExecuteOperationsInput = {
    ops: RemoteOp[]
    meta: Meta
    signal?: AbortSignal
}

export type ExecuteOperationsOutput = {
    results: RemoteOpResult[]
    status?: number
}

export type RemoteOperationEnvelope = Readonly<ExecuteOperationsInput & {
    target?: string
}>

export type RemoteOperationResultEnvelope = Readonly<ExecuteOperationsOutput>

export type OperationClient = Readonly<{
    executeOperations: (input: ExecuteOperationsInput) => Promise<ExecuteOperationsOutput>
}>
