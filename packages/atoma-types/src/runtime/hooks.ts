import type { Patch } from 'immer'
import type { Entity, OperationContext, Query, QueryResult, StoreToken, ExecutionRoute } from '../core'
import type { WriteEntry } from './persistence'
import type { StoreHandle } from './handle'

export type WriteHookSource =
    | 'addOne'
    | 'updateOne'
    | 'upsertOne'
    | 'deleteOne'
    | 'patches'

export type HookPayloadMap<T extends Entity = Entity> = Readonly<{
    readStart: Readonly<{
        handle: StoreHandle<T>
        query: Query<T>
    }>
    readFinish: Readonly<{
        handle: StoreHandle<T>
        query: Query<T>
        result: QueryResult<T>
        durationMs?: number
    }>
    writeStart: Readonly<{
        handle: StoreHandle<T>
        opContext: OperationContext
        entryCount: number
        source: WriteHookSource
        route?: ExecutionRoute
        writeEntries: ReadonlyArray<WriteEntry>
    }>
    writePatches: Readonly<{
        handle: StoreHandle<T>
        opContext: OperationContext
        patches: Patch[]
        inversePatches: Patch[]
        source: WriteHookSource
    }>
    writeCommitted: Readonly<{
        handle: StoreHandle<T>
        opContext: OperationContext
        route?: ExecutionRoute
        writeEntries: ReadonlyArray<WriteEntry>
        result?: unknown
    }>
    writeFailed: Readonly<{
        handle: StoreHandle<T>
        opContext: OperationContext
        route?: ExecutionRoute
        writeEntries: ReadonlyArray<WriteEntry>
        error: unknown
    }>
    storeCreated: Readonly<{
        handle: StoreHandle<T>
        storeName: StoreToken
    }>
}>

export type ReadStartArgs<T extends Entity = Entity> = HookPayloadMap<T>['readStart']
export type ReadFinishArgs<T extends Entity = Entity> = HookPayloadMap<T>['readFinish']
export type WriteStartArgs<T extends Entity = Entity> = HookPayloadMap<T>['writeStart']
export type WritePatchesArgs<T extends Entity = Entity> = HookPayloadMap<T>['writePatches']
export type WriteCommittedArgs<T extends Entity = Entity> = HookPayloadMap<T>['writeCommitted']
export type WriteFailedArgs<T extends Entity = Entity> = HookPayloadMap<T>['writeFailed']
export type StoreCreatedArgs<T extends Entity = Entity> = HookPayloadMap<T>['storeCreated']

export type HookEventName = keyof HookPayloadMap<Entity>

export type HookEmit = Readonly<{
    [K in HookEventName]: <T extends Entity>(args: HookPayloadMap<T>[K]) => void
}>

export type HookHandlers = Readonly<{
    [K in HookEventName]?: <T extends Entity>(args: HookPayloadMap<T>[K]) => void
}>

export type Hooks = Readonly<{
    read?: Readonly<{
        onStart?: HookHandlers['readStart']
        onFinish?: HookHandlers['readFinish']
    }>
    write?: Readonly<{
        onStart?: HookHandlers['writeStart']
        onPatches?: HookHandlers['writePatches']
        onCommitted?: HookHandlers['writeCommitted']
        onFailed?: HookHandlers['writeFailed']
    }>
    store?: Readonly<{
        onCreated?: HookHandlers['storeCreated']
    }>
}>

export type HookRegistry = Readonly<{
    register: (hooks: Hooks) => () => void
    has: Readonly<{
        event: (name: HookEventName) => boolean
        writePatches: boolean
    }>
    emit: HookEmit
}>
