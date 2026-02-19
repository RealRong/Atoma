import type { Entity, ExecutionRoute } from '../core'
import type {
    ExecutionOptions,
    QueryRequest,
    ExecutionQueryOutput,
    WriteRequest,
    WriteOutput,
    Consistency,
    WriteConsistency
} from './persistence'
import type { StoreHandle } from './handle'

export type ExecutorId = string

export type RouteSpec = Readonly<{
    query: ExecutorId
    write: ExecutorId
    consistency?: Consistency
}>

export type ExecutionBundle = Readonly<{
    id: string
    executors?: Readonly<Record<ExecutorId, ExecutionSpec>>
    routes?: Readonly<Record<ExecutionRoute, RouteSpec>>
    defaultRoute?: ExecutionRoute
}>

export type ExecutionResolution = Readonly<{
    route: ExecutionRoute
    executor: ExecutorId
}>

export type ExecutionErrorCode =
    | 'E_EXECUTION_BUNDLE_INVALID'
    | 'E_EXECUTION_CONFLICT'
    | 'E_ROUTE_NOT_FOUND'
    | 'E_ROUTE_INVALID'
    | 'E_EXECUTOR_NOT_FOUND'
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
        route: ExecutionRoute
        executor: ExecutorId
        resolution: ExecutionResolution
        request: WriteRequest<any>
        options?: ExecutionOptions
    }
    | {
        type: 'write.succeeded'
        route: ExecutionRoute
        executor: ExecutorId
        resolution: ExecutionResolution
        request: WriteRequest<any>
        options?: ExecutionOptions
        output: WriteOutput<any>
    }
    | {
        type: 'write.failed'
        route: ExecutionRoute
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
        route: ExecutionRoute
        executor: ExecutorId
        resolution: ExecutionResolution
        request: QueryRequest<any>
        options?: ExecutionOptions
    }
    | {
        type: 'query.succeeded'
        route: ExecutionRoute
        executor: ExecutorId
        resolution: ExecutionResolution
        request: QueryRequest<any>
        options?: ExecutionOptions
        output: ExecutionQueryOutput<any>
    }
    | {
        type: 'query.failed'
        route: ExecutionRoute
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
    write?: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput<T>>
    consistency?: Consistency
}>

export type ExecutionKernel = Readonly<{
    apply: (bundle: ExecutionBundle) => () => void
    resolveConsistency: <T extends Entity>(handle: StoreHandle<T>, options?: ExecutionOptions) => WriteConsistency
    subscribe: (listener: (event: ExecutionEvent) => void) => () => void
    query: <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions) => Promise<ExecutionQueryOutput<T>>
    write: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput<T>>
}>
