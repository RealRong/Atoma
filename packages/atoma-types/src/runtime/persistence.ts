import type { Entity, OperationContext, StoreToken, WriteStrategy } from '../core'
import type { WriteEntry, WriteItemResult } from '../protocol'
import type { StoreHandle } from './handle'

export type PersistStatus = 'confirmed' | 'enqueued'

export type PersistRequest<T extends Entity> = Readonly<{
    storeName: StoreToken
    writeStrategy?: WriteStrategy
    handle: StoreHandle<T>
    opContext: OperationContext
    writeEntries: ReadonlyArray<WriteEntry>
    signal?: AbortSignal
}>

export type PersistResult<T extends Entity> = Readonly<{
    status: PersistStatus
    results?: ReadonlyArray<WriteItemResult>
}>

export type PersistHandler = <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>

export type WritePolicy = Readonly<{
    implicitFetch?: boolean
    optimistic?: boolean
}>

export type StrategyDescriptor = Readonly<{
    persist?: PersistHandler
    write?: WritePolicy
}>

export interface Persistence {
    persist: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}
