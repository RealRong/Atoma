import type { Patch } from 'immer'
import type { Entity, OperationContext, Query, QueryResult, WriteIntent } from '../core'
import type { StoreHandle } from './handle'

export type WriteHookSource =
    | 'addOne'
    | 'updateOne'
    | 'upsertOne'
    | 'deleteOne'
    | 'patches'

export type ReadStartArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    query: Query<T>
}>

export type ReadFinishArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    query: Query<T>
    result: QueryResult<T>
    durationMs?: number
}>

export type WriteStartArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    intents: Array<WriteIntent<T>>
    source: WriteHookSource
}>

export type WritePatchesArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    patches: Patch[]
    inversePatches: Patch[]
    source: WriteHookSource
}>

export type WriteCommittedArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    result?: unknown
}>

export type WriteFailedArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    error: unknown
}>

export type StoreCreatedArgs<T extends Entity = Entity> = Readonly<{
    handle: StoreHandle<T>
    storeName: string
}>

export type HookEventName =
    | 'readStart'
    | 'readFinish'
    | 'writeStart'
    | 'writePatches'
    | 'writeCommitted'
    | 'writeFailed'
    | 'storeCreated'

export type Hooks = Readonly<{
    read?: Readonly<{
        onStart?: <T extends Entity>(args: ReadStartArgs<T>) => void
        onFinish?: <T extends Entity>(args: ReadFinishArgs<T>) => void
    }>
    write?: Readonly<{
        onStart?: <T extends Entity>(args: WriteStartArgs<T>) => void
        onPatches?: <T extends Entity>(args: WritePatchesArgs<T>) => void
        onCommitted?: <T extends Entity>(args: WriteCommittedArgs<T>) => void
        onFailed?: <T extends Entity>(args: WriteFailedArgs<T>) => void
    }>
    store?: Readonly<{
        onCreated?: <T extends Entity>(args: StoreCreatedArgs<T>) => void
    }>
}>

export type HookRegistry = Readonly<{
    register: (hooks: Hooks) => () => void
    has: Readonly<{
        event: (name: HookEventName) => boolean
        writePatches: boolean
    }>
    emit: Readonly<{
        readStart: <T extends Entity>(args: ReadStartArgs<T>) => void
        readFinish: <T extends Entity>(args: ReadFinishArgs<T>) => void
        writeStart: <T extends Entity>(args: WriteStartArgs<T>) => void
        writePatches: <T extends Entity>(args: WritePatchesArgs<T>) => void
        writeCommitted: <T extends Entity>(args: WriteCommittedArgs<T>) => void
        writeFailed: <T extends Entity>(args: WriteFailedArgs<T>) => void
        storeCreated: <T extends Entity>(args: StoreCreatedArgs<T>) => void
    }>
}>
