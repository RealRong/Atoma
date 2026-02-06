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
