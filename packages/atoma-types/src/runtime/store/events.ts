import type { Entity, ActionContext, Query, QueryResult, StoreToken, StoreChange, WriteManyResult } from '../../core'
import type { WriteEntry, WriteStatus } from '../persistence'

export type WriteEventSource =
    | 'create'
    | 'update'
    | 'upsert'
    | 'delete'

export type ChangeDirection =
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
        direction: ChangeDirection
        changes: ReadonlyArray<StoreChange<T>>
    }>
    changeCommitted: Readonly<{
        storeName: StoreToken
        context: ActionContext
        direction: ChangeDirection
        changes: ReadonlyArray<StoreChange<T>>
    }>
    changeFailed: Readonly<{
        storeName: StoreToken
        context: ActionContext
        direction: ChangeDirection
        changes: ReadonlyArray<StoreChange<T>>
        error: unknown
    }>
    storeCreated: Readonly<{
        storeName: StoreToken
    }>
}>

export type StoreEventName = keyof StoreEventPayloadMap<Entity>

export type StoreEventListener<K extends StoreEventName = StoreEventName> = <T extends Entity>(args: StoreEventPayloadMap<T>[K]) => void

export type StoreEventListenerOptions = Readonly<{
    once?: boolean
    signal?: AbortSignal
}>

export type StoreEventBus = Readonly<{
    on: <K extends StoreEventName>(
        name: K,
        listener: StoreEventListener<K>,
        options?: StoreEventListenerOptions
    ) => () => void
    off: <K extends StoreEventName>(name: K, listener: StoreEventListener<K>) => void
    once: <K extends StoreEventName>(name: K, listener: StoreEventListener<K>) => () => void
    emit: <K extends StoreEventName, T extends Entity = Entity>(name: K, payload: StoreEventPayloadMap<T>[K]) => void
    has: Readonly<{
        event: (name: StoreEventName) => boolean
    }>
}>
