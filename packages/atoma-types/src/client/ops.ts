import { defineCapability } from './registry'
import type { CapabilitiesRegistry } from './registry'
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

export const OPERATION_CLIENT_CAPABILITY = defineCapability<OperationClient>('client.operations')

export function registerOperationClient(capabilities: CapabilitiesRegistry, client: OperationClient): (() => void) {
    return capabilities.register(OPERATION_CLIENT_CAPABILITY, client)
}

export function getOperationClient(capabilities: CapabilitiesRegistry): OperationClient | undefined {
    return capabilities.get(OPERATION_CLIENT_CAPABILITY)
}
