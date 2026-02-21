import type { Entity } from '../core'
import type {
    ExecutionOptions,
    QueryRequest,
    ExecutionQueryOutput,
    WriteRequest,
    WriteOutput,
    WriteConsistency
} from './persistence'
import type { StoreHandle } from './store/handle'

export type ExecutorId = string
export type ExecutionPhase = 'query' | 'write'

export type ExecutionBundle = Readonly<{
    id: string
    executor: ExecutionSpec
}>

export type ExecutionResolution = Readonly<{
    executor: ExecutorId
}>

export type ExecutionErrorCode =
    | 'E_EXECUTION_BUNDLE_INVALID'
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

export type ExecutionWriteEvent = Readonly<
    | {
        type: 'write.dispatched'
        executor: ExecutorId
        resolution: ExecutionResolution
        request: WriteRequest<any>
        options?: ExecutionOptions
    }
    | {
        type: 'write.succeeded'
        executor: ExecutorId
        resolution: ExecutionResolution
        request: WriteRequest<any>
        options?: ExecutionOptions
        output: WriteOutput
    }
    | {
        type: 'write.failed'
        executor: ExecutorId
        resolution: ExecutionResolution
        request: WriteRequest<any>
        options?: ExecutionOptions
        error: ExecutionError
    }
>

export type ExecutionQueryEvent = Readonly<
    | {
        type: 'query.dispatched'
        executor: ExecutorId
        resolution: ExecutionResolution
        request: QueryRequest<any>
        options?: ExecutionOptions
    }
    | {
        type: 'query.succeeded'
        executor: ExecutorId
        resolution: ExecutionResolution
        request: QueryRequest<any>
        options?: ExecutionOptions
        output: ExecutionQueryOutput<any>
    }
    | {
        type: 'query.failed'
        executor: ExecutorId
        resolution: ExecutionResolution
        request: QueryRequest<any>
        options?: ExecutionOptions
        error: ExecutionError
    }
>

export type ExecutionEvent = ExecutionWriteEvent | ExecutionQueryEvent

export type ExecutionSpec = Readonly<{
    query?: <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions) => Promise<ExecutionQueryOutput<T>>
    write?: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput>
    consistency?: Partial<WriteConsistency>
}>

export type ExecutionKernel = Readonly<{
    apply: (bundle: ExecutionBundle) => () => void
    resolveConsistency: <T extends Entity>(handle: StoreHandle<T>, options?: ExecutionOptions) => WriteConsistency
    hasExecutor: (phase: ExecutionPhase) => boolean
    subscribe: (listener: (event: ExecutionEvent) => void) => () => void
    query: <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions) => Promise<ExecutionQueryOutput<T>>
    write: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput>
}>
