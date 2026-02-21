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

export type ExecutionErrorCode =
    | 'E_EXECUTION_REGISTER_INVALID'
    | 'E_EXECUTION_CONFLICT'
    | 'E_EXECUTOR_MISSING'
    | 'E_EXECUTOR_QUERY_UNIMPLEMENTED'
    | 'E_EXECUTOR_WRITE_UNIMPLEMENTED'
    | 'E_EXECUTION_QUERY_FAILED'
    | 'E_EXECUTION_WRITE_FAILED'
    | 'E_OPERATION_CLIENT_MISSING'
    | 'E_OPERATION_RESULT_MISSING'
    | 'E_OPERATION_FAILED'
    | (string & {})

export type ExecutionError = Error & Readonly<{
    code: ExecutionErrorCode
    retryable: boolean
    details?: Readonly<Record<string, unknown>>
    cause?: unknown
}>

export type ExecutionSpec = Readonly<{
    query?: <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions) => Promise<ExecutionQueryOutput<T>>
    write?: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput>
    consistency?: Partial<WriteConsistency>
}>

export type ExecutionRegistration = Readonly<{
    id?: string
} & ExecutionSpec>

export type ExecutionKernel = Readonly<{
    register: (registration: ExecutionRegistration) => () => void
    getConsistency: () => WriteConsistency
    hasExecutor: (phase: ExecutionPhase) => boolean
    query: <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions) => Promise<ExecutionQueryOutput<T>>
    write: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput>
}>
