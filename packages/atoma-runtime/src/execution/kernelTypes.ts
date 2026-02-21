import type {
    ExecutionResolution,
    ExecutionSpec,
} from 'atoma-types/runtime'

export type KernelPhase = 'query' | 'write'

export type KernelLayer = Readonly<{
    token: symbol
    id: string
    executor: ExecutionSpec
}>

export type KernelResolvedExecution = Readonly<{
    resolution: ExecutionResolution
    spec: ExecutionSpec
}>

export type KernelSnapshot = Readonly<{
    query?: KernelResolvedExecution
    write?: KernelResolvedExecution
}>
