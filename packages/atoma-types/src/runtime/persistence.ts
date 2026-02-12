import type { Entity, OperationContext, Query, StoreToken, WriteStrategy } from '../core'
import type { WriteEntry, WriteItemResult } from '../protocol'
import type { StoreHandle } from './handle'

export type WriteStatus = 'confirmed' | 'enqueued'

export type WriteInput<T extends Entity> = Readonly<{
    storeName: StoreToken
    writeStrategy?: WriteStrategy
    handle: StoreHandle<T>
    opContext: OperationContext
    writeEntries: ReadonlyArray<WriteEntry>
    signal?: AbortSignal
}>

export type WriteOutput<T extends Entity> = Readonly<{
    status: WriteStatus
    results?: ReadonlyArray<WriteItemResult>
}>

export type WriteExecutor = <T extends Entity>(input: WriteInput<T>) => Promise<WriteOutput<T>>

export type QueryInput<T extends Entity> = Readonly<{
    storeName: StoreToken
    handle: StoreHandle<T>
    query: Query<T>
    signal?: AbortSignal
}>

export type QueryOutput = Readonly<{
    data: unknown[]
    pageInfo?: unknown
}>

export type QueryExecutor = <T extends Entity>(input: QueryInput<T>) => Promise<QueryOutput>

export type Policy = Readonly<{
    implicitFetch?: boolean
    optimistic?: boolean
}>

export type StrategySpec = Readonly<{
    query?: QueryExecutor
    write?: WriteExecutor
    policy?: Policy
}>

export interface WritePort {
    write: <T extends Entity>(input: WriteInput<T>) => Promise<WriteOutput<T>>
}
