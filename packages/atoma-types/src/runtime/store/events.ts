import type { Entity, ActionContext, Query, QueryResult, StoreToken, StoreChange, WriteManyResult } from '../../core'
import type { WriteEntry, WriteStatus } from '../persistence'

export type WriteEventSource =
    | 'create'
    | 'update'
    | 'upsert'
    | 'delete'

export type ChangeEventSource =
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
        writeEntries: ReadonlyArray<WriteEntry>
    }>
    writeCommitted: Readonly<{
        storeName: StoreToken
        context: ActionContext
        writeEntries: ReadonlyArray<WriteEntry>
        status?: WriteStatus
        results?: WriteManyResult<unknown>
        result?: unknown
        changes?: ReadonlyArray<StoreChange<T>>
    }>
    writeFailed: Readonly<{
        storeName: StoreToken
        context: ActionContext
        writeEntries: ReadonlyArray<WriteEntry>
        error: unknown
    }>
    changeStart: Readonly<{
        storeName: StoreToken
        context: ActionContext
        source: ChangeEventSource
        changes: ReadonlyArray<StoreChange<T>>
    }>
    changeCommitted: Readonly<{
        storeName: StoreToken
        context: ActionContext
        source: ChangeEventSource
        changes: ReadonlyArray<StoreChange<T>>
    }>
    changeFailed: Readonly<{
        storeName: StoreToken
        context: ActionContext
        source: ChangeEventSource
        changes: ReadonlyArray<StoreChange<T>>
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
    change?: Readonly<{
        onStart?: StoreEventHandlers['changeStart']
        onCommitted?: StoreEventHandlers['changeCommitted']
        onFailed?: StoreEventHandlers['changeFailed']
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
