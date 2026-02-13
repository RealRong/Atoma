import type { Entity, WriteStrategy } from '../core'
import type {
    QueryInput,
    QueryOutput,
    WriteInput,
    WriteOutput,
    Policy
} from './persistence'

export type ExecutionWriteEvent = Readonly<
    | {
        type: 'write.succeeded'
        strategy: WriteStrategy
        input: WriteInput<any>
        output: WriteOutput<any>
    }
    | {
        type: 'write.failed'
        strategy: WriteStrategy
        input: WriteInput<any>
        error: unknown
    }
>

export type ExecutionQueryEvent = Readonly<
    | {
        type: 'query.succeeded'
        strategy: WriteStrategy
        input: QueryInput<any>
        output: QueryOutput
    }
    | {
        type: 'query.failed'
        strategy: WriteStrategy
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

export type ExecutionRegistry = Readonly<{
    register: (key: WriteStrategy, spec: ExecutionSpec) => () => void
    setDefault: (key: WriteStrategy) => () => void
    resolvePolicy: (key?: WriteStrategy) => Policy
    subscribe: (listener: (event: ExecutionEvent) => void) => () => void
    query: <T extends Entity>(input: QueryInput<T>) => Promise<QueryOutput>
    write: <T extends Entity>(input: WriteInput<T>) => Promise<WriteOutput<T>>
}>
