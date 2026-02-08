import type { Entity, OperationContext, StoreToken, WriteStrategy } from '../core'
import type { OperationResult, WriteOp } from '../protocol'
import type { StoreHandle } from './handle'

export type PersistStatus = 'confirmed' | 'enqueued'

export type PersistRequest<T extends Entity> = Readonly<{
    storeName: StoreToken
    writeStrategy?: WriteStrategy
    handle: StoreHandle<T>
    opContext?: OperationContext
    writeOps: Array<WriteOp>
    signal?: AbortSignal
}>

export type PersistResult<T extends Entity> = Readonly<{
    status: PersistStatus
    results?: OperationResult[]
}>

export type PersistHandler = <T extends Entity>(args: {
    req: PersistRequest<T>
    next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
}) => Promise<PersistResult<T>>

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
