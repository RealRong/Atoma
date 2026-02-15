import type { Patch } from 'immer'
import type { Entity, OperationContext, Query, QueryResult, StoreToken, ExecutionRoute } from '../core'
import type { WriteEntry } from './persistence'
import type { StoreHandle } from './handle'

export type WriteEventSource =
    | 'addOne'
    | 'updateOne'
    | 'upsertOne'
    | 'deleteOne'
    | 'patches'

export type StoreEventPayloadMap<T extends Entity = Entity> = Readonly<{
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
        source: WriteEventSource
        route?: ExecutionRoute
        writeEntries: ReadonlyArray<WriteEntry>
    }>
    writePatches: Readonly<{
        handle: StoreHandle<T>
        opContext: OperationContext
        patches: Patch[]
        inversePatches: Patch[]
        source: WriteEventSource
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

export type ReadStartArgs<T extends Entity = Entity> = StoreEventPayloadMap<T>['readStart']
export type ReadFinishArgs<T extends Entity = Entity> = StoreEventPayloadMap<T>['readFinish']
export type WriteStartArgs<T extends Entity = Entity> = StoreEventPayloadMap<T>['writeStart']
export type WritePatchesArgs<T extends Entity = Entity> = StoreEventPayloadMap<T>['writePatches']
export type WriteCommittedArgs<T extends Entity = Entity> = StoreEventPayloadMap<T>['writeCommitted']
export type WriteFailedArgs<T extends Entity = Entity> = StoreEventPayloadMap<T>['writeFailed']
export type StoreCreatedArgs<T extends Entity = Entity> = StoreEventPayloadMap<T>['storeCreated']

export type StoreEventName = keyof StoreEventPayloadMap<Entity>

export type StoreEventEmit = Readonly<{
    [K in StoreEventName]: <T extends Entity>(args: StoreEventPayloadMap<T>[K]) => void
}>

export type StoreEventHandlers = Readonly<{
    [K in StoreEventName]?: <T extends Entity>(args: StoreEventPayloadMap<T>[K]) => void
}>

export type StoreEvents = Readonly<{
    read?: Readonly<{
        onStart?: StoreEventHandlers['readStart']
        onFinish?: StoreEventHandlers['readFinish']
    }>
    write?: Readonly<{
        onStart?: StoreEventHandlers['writeStart']
        onPatches?: StoreEventHandlers['writePatches']
        onCommitted?: StoreEventHandlers['writeCommitted']
        onFailed?: StoreEventHandlers['writeFailed']
    }>
    store?: Readonly<{
        onCreated?: StoreEventHandlers['storeCreated']
    }>
}>

export type StoreEventRegistry = Readonly<{
    register: (events: StoreEvents) => () => void
    has: Readonly<{
        event: (name: StoreEventName) => boolean
        writePatches: boolean
    }>
    emit: StoreEventEmit
}>
