import type { Meta, RemoteOp, RemoteOpResult } from '../protocol'
import { createServiceToken } from './services'

export type ExecuteOperationsInput = {
    ops: RemoteOp[]
    meta: Meta
    signal?: AbortSignal
}

export type ExecuteOperationsOutput = {
    results: RemoteOpResult[]
    status?: number
}

export type OperationClient = Readonly<{
    executeOperations: (input: ExecuteOperationsInput) => Promise<ExecuteOperationsOutput>
}>

export const OPERATION_CLIENT_TOKEN = createServiceToken<OperationClient>('operation.client')
