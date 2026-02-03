import type { Meta, Operation, OperationResult } from '../../protocol'

export type OperationEnvelope = Readonly<{
    target?: string
    ops: Operation[]
    meta: Meta
    signal?: AbortSignal
}>

export type ResultEnvelope = Readonly<{
    results: OperationResult[]
    status?: number
}>

export type Driver = Readonly<{
    executeOps: (req: OperationEnvelope) => Promise<ResultEnvelope>
    dispose?: () => void | Promise<void>
}>

export type Endpoint = Readonly<{
    id: string
    role: string
    driver: Driver
}>
