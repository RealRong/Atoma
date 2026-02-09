import type { Patch } from 'immer'
import type { Entity, OperationContext, Query, QueryResult, WriteIntent } from '../core'
import type { StoreHandle } from './handle'

export type RuntimeWriteHookSource =
    | 'addOne'
    | 'updateOne'
    | 'upsertOne'
    | 'deleteOne'
    | 'patches'

export type RuntimeReadStartArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    query: Query<T>
}>

export type RuntimeReadFinishArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    query: Query<T>
    result: QueryResult<T>
    durationMs?: number
}>

export type RuntimeWriteStartArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    intents: Array<WriteIntent<T>>
    source: RuntimeWriteHookSource
}>

export type RuntimeWritePatchesArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    patches: Patch[]
    inversePatches: Patch[]
    source: RuntimeWriteHookSource
}>

export type RuntimeWriteCommittedArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    result?: unknown
}>

export type RuntimeWriteFailedArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    error: unknown
}>

export type RuntimeStoreCreatedArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    storeName: string
}>

export type RuntimeHookEventName =
    | 'readStart'
    | 'readFinish'
    | 'writeStart'
    | 'writePatches'
    | 'writeCommitted'
    | 'writeFailed'
    | 'storeCreated'

export type RuntimeHooks = Readonly<{
    read?: Readonly<{
        onStart?: <T extends Entity>(args: RuntimeReadStartArgs<T>) => void
        onFinish?: <T extends Entity>(args: RuntimeReadFinishArgs<T>) => void
    }>
    write?: Readonly<{
        onStart?: <T extends Entity>(args: RuntimeWriteStartArgs<T>) => void
        onPatches?: <T extends Entity>(args: RuntimeWritePatchesArgs<T>) => void
        onCommitted?: <T extends Entity>(args: RuntimeWriteCommittedArgs<T>) => void
        onFailed?: <T extends Entity>(args: RuntimeWriteFailedArgs<T>) => void
    }>
    store?: Readonly<{
        onCreated?: <T extends Entity>(args: RuntimeStoreCreatedArgs<T>) => void
    }>
}>

export type RuntimeHookRegistry = Readonly<{
    register: (hooks: RuntimeHooks) => () => void
    has: Readonly<{
        event: (name: RuntimeHookEventName) => boolean
        writePatches: boolean
    }>
    emit: Readonly<{
        readStart: <T extends Entity>(args: RuntimeReadStartArgs<T>) => void
        readFinish: <T extends Entity>(args: RuntimeReadFinishArgs<T>) => void
        writeStart: <T extends Entity>(args: RuntimeWriteStartArgs<T>) => void
        writePatches: <T extends Entity>(args: RuntimeWritePatchesArgs<T>) => void
        writeCommitted: <T extends Entity>(args: RuntimeWriteCommittedArgs<T>) => void
        writeFailed: <T extends Entity>(args: RuntimeWriteFailedArgs<T>) => void
        storeCreated: <T extends Entity>(args: RuntimeStoreCreatedArgs<T>) => void
    }>
}>
