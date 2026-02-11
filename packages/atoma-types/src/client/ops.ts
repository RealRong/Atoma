import { defineCapability } from './registry'
import type { CapabilitiesRegistry } from './registry'
import type { Meta, RemoteOp, RemoteOpResult } from '../protocol'

export type ExecuteOpsInput = {
    ops: RemoteOp[]
    meta: Meta
    signal?: AbortSignal
}

export type ExecuteOpsOutput = {
    results: RemoteOpResult[]
    status?: number
}

export type RemoteOpEnvelope = Readonly<ExecuteOpsInput & {
    target?: string
}>

export type RemoteOpResultEnvelope = Readonly<ExecuteOpsOutput>

export type OpsClientLike = Readonly<{
    executeOps: (input: ExecuteOpsInput) => Promise<ExecuteOpsOutput>
}>

export const OPS_CLIENT_CAPABILITY = defineCapability<OpsClientLike>('client.ops')

export function registerOpsClient(capabilities: CapabilitiesRegistry, client: OpsClientLike): (() => void) {
    return capabilities.register(OPS_CLIENT_CAPABILITY, client)
}

export function getOpsClient(capabilities: CapabilitiesRegistry): OpsClientLike | undefined {
    return capabilities.get(OPS_CLIENT_CAPABILITY)
}
