import type { StoreToken } from '../core'
import type { Meta, RemoteOp, RemoteOpResult } from '../protocol'
import type { WriteEntry as ProtocolWriteEntry } from '../protocol'
import type { WriteEntry as RuntimeWriteEntry } from '../runtime'
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

export type WriteCoordinator = Readonly<{
    encode: (args: {
        storeName: StoreToken
        entries: ReadonlyArray<RuntimeWriteEntry>
    }) => ReadonlyArray<ProtocolWriteEntry>
}>

export const OPERATION_CLIENT_TOKEN = createServiceToken<OperationClient>('operation.client')
export const WRITE_COORDINATOR_TOKEN = createServiceToken<WriteCoordinator>('write.coordinator')
