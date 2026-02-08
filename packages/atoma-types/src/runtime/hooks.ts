import type { Patch } from 'immer'
import type { OperationContext, Query, QueryResult, WriteIntent } from '../core'
import type { StoreHandle } from './handle'

export type RuntimeWriteHookSource =
    | 'addOne'
    | 'updateOne'
    | 'upsertOne'
    | 'deleteOne'
    | 'patches'

export type RuntimeReadStartArgs = Readonly<{
    handle: StoreHandle<any>
    query: Query<any>
}>

export type RuntimeReadFinishArgs = Readonly<{
    handle: StoreHandle<any>
    query: Query<any>
    result: QueryResult<any>
    durationMs?: number
}>

export type RuntimeWriteStartArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: OperationContext
    intents: Array<WriteIntent<any>>
    source: RuntimeWriteHookSource
}>

export type RuntimeWritePatchesArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: OperationContext
    patches: Patch[]
    inversePatches: Patch[]
    source: RuntimeWriteHookSource
}>

export type RuntimeWriteCommittedArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: OperationContext
    result?: unknown
}>

export type RuntimeWriteFailedArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: OperationContext
    error: unknown
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
        onStart?: (args: RuntimeReadStartArgs) => void
        onFinish?: (args: RuntimeReadFinishArgs) => void
    }>
    write?: Readonly<{
        onStart?: (args: RuntimeWriteStartArgs) => void
        onPatches?: (args: RuntimeWritePatchesArgs) => void
        onCommitted?: (args: RuntimeWriteCommittedArgs) => void
        onFailed?: (args: RuntimeWriteFailedArgs) => void
    }>
    store?: Readonly<{
        onCreated?: (args: {
            handle: StoreHandle<any>
            storeName: string
        }) => void
    }>
}>

export type RuntimeHookRegistry = Readonly<{
    register: (hooks: RuntimeHooks) => () => void
    has: Readonly<{
        event: (name: RuntimeHookEventName) => boolean
        writePatches: boolean
    }>
    emit: Readonly<{
        readStart: (args: RuntimeReadStartArgs) => void
        readFinish: (args: RuntimeReadFinishArgs) => void
        writeStart: (args: RuntimeWriteStartArgs) => void
        writePatches: (args: RuntimeWritePatchesArgs) => void
        writeCommitted: (args: RuntimeWriteCommittedArgs) => void
        writeFailed: (args: RuntimeWriteFailedArgs) => void
        storeCreated: (args: {
            handle: StoreHandle<any>
            storeName: string
        }) => void
    }>
}>
