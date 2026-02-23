import type { Entity } from '../core'
import type {
    ExecutionOptions,
    QueryRequest,
    ExecutionQueryOutput,
    WriteRequest,
    WriteOutput,
    WriteConsistency
} from './persistence'

export type ExecutionPhase = 'query' | 'write'

export type ExecutionRegistration = Readonly<{
    id?: string
    query?: <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions) => Promise<ExecutionQueryOutput<T>>
    write?: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput>
    consistency?: Partial<WriteConsistency>
}>

export type ExecutionKernel = Readonly<{
    register: (registration: ExecutionRegistration) => () => void
    getConsistency: () => WriteConsistency
    hasExecutor: (phase: ExecutionPhase) => boolean
    query: <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions) => Promise<ExecutionQueryOutput<T>>
    write: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput>
}>
