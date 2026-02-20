import type { Entity, ActionContext, Query, QueryResult, StoreToken, ExecutionRoute, StoreChange } from '../../core'
import type { WriteEntry } from '../persistence'

export type WriteEventSource =
    | 'create'
    | 'update'
    | 'upsert'
    | 'delete'
    | 'apply'
    | 'revert'

export type StoreEventPayloadMap<T extends Entity = Entity> = Readonly<{
    readStart: Readonly<{
        storeName: StoreToken
        query: Query<T>
    }>
    readFinish: Readonly<{
        storeName: StoreToken
        query: Query<T>
        result: QueryResult<T>
        durationMs?: number
    }>
    writeStart: Readonly<{
        storeName: StoreToken
        context: ActionContext
        source: WriteEventSource
        route?: ExecutionRoute
        writeEntries: ReadonlyArray<WriteEntry>
    }>
    writeCommitted: Readonly<{
        storeName: StoreToken
        context: ActionContext
        route?: ExecutionRoute
        writeEntries: ReadonlyArray<WriteEntry>
        result?: unknown
        changes?: ReadonlyArray<StoreChange<T>>
    }>
    writeFailed: Readonly<{
        storeName: StoreToken
        context: ActionContext
        route?: ExecutionRoute
        writeEntries: ReadonlyArray<WriteEntry>
        error: unknown
    }>
    storeCreated: Readonly<{
        storeName: StoreToken
    }>
}>

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
    }>
    emit: StoreEventEmit
}>
