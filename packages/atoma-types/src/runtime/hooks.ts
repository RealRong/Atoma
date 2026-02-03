import type { Patch } from 'immer'
import type * as Types from '../core'
import type { StoreHandle } from './handleTypes'

export type RuntimeWriteHookSource =
    | 'addOne'
    | 'updateOne'
    | 'upsertOne'
    | 'deleteOne'
    | 'patches'

export type RuntimeReadStartArgs = Readonly<{
    handle: StoreHandle<any>
    query: Types.Query<any>
}>

export type RuntimeReadFinishArgs = Readonly<{
    handle: StoreHandle<any>
    query: Types.Query<any>
    result: Types.QueryResult<any>
    durationMs?: number
}>

export type RuntimeWriteStartArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    intents: Array<Types.WriteIntent<any>>
    source: RuntimeWriteHookSource
}>

export type RuntimeWritePatchesArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    patches: Patch[]
    inversePatches: Patch[]
    source: RuntimeWriteHookSource
}>

export type RuntimeWriteCommittedArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    result?: unknown
}>

export type RuntimeWriteFailedArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    error: unknown
}>

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
            debug?: Types.DebugConfig
            debugSink?: (e: Types.DebugEvent) => void
        }) => void
    }>
}>

export type RuntimeHookRegistry = Readonly<{
    register: (hooks: RuntimeHooks) => () => void
    has: Readonly<{ writePatches: boolean }>
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
            debug?: Types.DebugConfig
            debugSink?: (e: Types.DebugEvent) => void
        }) => void
    }>
}>
