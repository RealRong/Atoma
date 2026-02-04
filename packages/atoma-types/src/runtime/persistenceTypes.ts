import type * as Types from '../core'
import type { OperationResult, WriteOp } from '../protocol'
import type { StoreHandle } from './handleTypes'

export type PersistStatus = 'confirmed' | 'enqueued'

export type PersistRequest<T extends Types.Entity> = Readonly<{
    storeName: Types.StoreToken
    writeStrategy?: Types.WriteStrategy
    handle: StoreHandle<T>
    opContext?: Types.OperationContext
    writeOps: Array<WriteOp>
    signal?: AbortSignal
}>

export type PersistResult<T extends Types.Entity> = Readonly<{
    status: PersistStatus
    /** Raw ops results for write ops (if confirmed). */
    results?: OperationResult[]
}>

export type PersistHandler = <T extends Types.Entity>(args: {
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
    persist: <T extends Types.Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}
