import type { Entity, WriteRoute } from '../core'
import type {
    QueryInput,
    QueryOutput,
    WriteInput,
    WriteOutput,
    Policy
} from './persistence'

export type ExecutorId = string

export type RouteId = WriteRoute

export type RouteSpec = Readonly<{
    query: ExecutorId
    write: ExecutorId
    policy?: Policy
}>

export type ExecutionBundle = Readonly<{
    id: string
    executors?: Readonly<Record<ExecutorId, ExecutionSpec>>
    routes?: Readonly<Record<RouteId, RouteSpec>>
    defaultRoute?: RouteId
    allowOverride?: boolean
}>

export type ExecutionResolutionSource =
    | 'explicit-route'
    | 'default-route'

export type ExecutionResolution = Readonly<{
    source: ExecutionResolutionSource
    route: RouteId
    executor: ExecutorId
    trace: ReadonlyArray<ExecutorId>
}>

export type ExecutionWriteEvent = Readonly<
    | {
        type: 'write.dispatched'
        route: RouteId
        executor: ExecutorId
        resolution: ExecutionResolution
        input: WriteInput<any>
    }
    | {
        type: 'write.succeeded'
        route: RouteId
        executor: ExecutorId
        resolution: ExecutionResolution
        input: WriteInput<any>
        output: WriteOutput<any>
    }
    | {
        type: 'write.failed'
        route: RouteId
        executor: ExecutorId
        resolution: ExecutionResolution
        input: WriteInput<any>
        error: unknown
    }
>

export type ExecutionQueryEvent = Readonly<
    | {
        type: 'query.dispatched'
        route: RouteId
        executor: ExecutorId
        resolution: ExecutionResolution
        input: QueryInput<any>
    }
    | {
        type: 'query.succeeded'
        route: RouteId
        executor: ExecutorId
        resolution: ExecutionResolution
        input: QueryInput<any>
        output: QueryOutput
    }
    | {
        type: 'query.failed'
        route: RouteId
        executor: ExecutorId
        resolution: ExecutionResolution
        input: QueryInput<any>
        error: unknown
    }
>

export type ExecutionEvent = ExecutionWriteEvent | ExecutionQueryEvent

export type ExecutionSpec = Readonly<{
    query?: <T extends Entity>(input: QueryInput<T>) => Promise<QueryOutput>
    write?: <T extends Entity>(input: WriteInput<T>) => Promise<WriteOutput<T>>
    policy?: Policy
}>

export type ExecutionKernel = Readonly<{
    apply: (bundle: ExecutionBundle) => () => void
    resolvePolicy: (route?: RouteId) => Policy
    subscribe: (listener: (event: ExecutionEvent) => void) => () => void
    query: <T extends Entity>(input: QueryInput<T>) => Promise<QueryOutput>
    write: <T extends Entity>(input: WriteInput<T>) => Promise<WriteOutput<T>>
}>
