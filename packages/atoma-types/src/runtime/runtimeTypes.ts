import type { Operation, OperationResult, EntityId } from '../protocol'
import type * as Types from '../core'
import type { Draft, Patch } from 'immer'
import type { StoreHandle, StoreStateWriterApi } from './handleTypes'
import type { PersistRequest, PersistResult, StrategyDescriptor, WritePolicy } from './persistenceTypes'
import type { RuntimeHookRegistry } from './hooks'

export type DataProcessor = Readonly<{
    process: <T>(mode: Types.DataProcessorMode, data: T, context: Types.DataProcessorBaseContext<T> & { dataProcessor?: Types.StoreDataProcessor<T> }) => Promise<T | undefined>
    inbound: <T extends Types.Entity>(handle: StoreHandle<T>, data: T, opContext?: Types.OperationContext) => Promise<T | undefined>
    writeback: <T extends Types.Entity>(handle: StoreHandle<T>, data: T, opContext?: Types.OperationContext) => Promise<T | undefined>
    outbound: <T extends Types.Entity>(handle: StoreHandle<T>, data: T, opContext?: Types.OperationContext) => Promise<T | undefined>
}>

/**
 * CoreRuntime：唯一上下文，承载跨 store 能力（read/write/persistence/resolveStore）
 */
export type StoreRegistry = Readonly<{
    resolve: (name: Types.StoreToken) => Types.IStore<any> | undefined
    ensure: (name: Types.StoreToken) => Types.IStore<any>
    list: () => Iterable<Types.IStore<any>>
    onCreated: (listener: (store: Types.IStore<any>) => void, options?: { replay?: boolean }) => () => void
    resolveHandle: (name: Types.StoreToken, tag?: string) => StoreHandle<any>
}>

export type RuntimeIo = Readonly<{
    executeOps: (args: { ops: Operation[]; signal?: AbortSignal }) => Promise<OperationResult[]>
    query: <T extends Types.Entity>(handle: StoreHandle<T>, query: Types.Query, signal?: AbortSignal) => Promise<{ data: unknown[]; pageInfo?: any }>
}>

export type RuntimeTransform = Readonly<{
    inbound: <T extends Types.Entity>(handle: StoreHandle<T>, data: T, ctx?: Types.OperationContext) => Promise<T | undefined>
    writeback: <T extends Types.Entity>(handle: StoreHandle<T>, data: T, ctx?: Types.OperationContext) => Promise<T | undefined>
    outbound: <T extends Types.Entity>(handle: StoreHandle<T>, data: T, ctx?: Types.OperationContext) => Promise<T | undefined>
}>

export type RuntimeRead = Readonly<{
    query: <T extends Types.Entity>(handle: StoreHandle<T>, query: Types.Query<T>) => Promise<Types.QueryResult<T>>
    queryOne: <T extends Types.Entity>(handle: StoreHandle<T>, query: Types.Query<T>) => Promise<Types.QueryOneResult<T>>
    getMany: <T extends Types.Entity>(handle: StoreHandle<T>, ids: EntityId[], cache?: boolean, options?: Types.StoreReadOptions) => Promise<T[]>
    getOne: <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, options?: Types.StoreReadOptions) => Promise<T | undefined>
    fetchOne: <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, options?: Types.StoreReadOptions) => Promise<T | undefined>
    fetchAll: <T extends Types.Entity>(handle: StoreHandle<T>, options?: Types.StoreReadOptions) => Promise<T[]>
    getAll: <T extends Types.Entity>(handle: StoreHandle<T>, filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: Types.StoreReadOptions) => Promise<T[]>
}>

export type RuntimeWrite = Readonly<{
    addOne: <T extends Types.Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: Types.StoreOperationOptions) => Promise<T>
    addMany: <T extends Types.Entity>(handle: StoreHandle<T>, items: Array<Partial<T>>, options?: Types.StoreOperationOptions) => Promise<T[]>
    updateOne: <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, recipe: (draft: Draft<T>) => void, options?: Types.StoreOperationOptions) => Promise<T>
    updateMany: <T extends Types.Entity>(handle: StoreHandle<T>, items: Array<{ id: EntityId; recipe: (draft: Draft<T>) => void }>, options?: Types.StoreOperationOptions) => Promise<Types.WriteManyResult<T>>
    upsertOne: <T extends Types.Entity>(handle: StoreHandle<T>, item: Types.PartialWithId<T>, options?: Types.StoreOperationOptions & Types.UpsertWriteOptions) => Promise<T>
    upsertMany: <T extends Types.Entity>(handle: StoreHandle<T>, items: Array<Types.PartialWithId<T>>, options?: Types.StoreOperationOptions & Types.UpsertWriteOptions) => Promise<Types.WriteManyResult<T>>
    deleteOne: <T extends Types.Entity>(handle: StoreHandle<T>, id: EntityId, options?: Types.StoreOperationOptions) => Promise<boolean>
    deleteMany: <T extends Types.Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: Types.StoreOperationOptions) => Promise<Types.WriteManyResult<boolean>>
    patches: <T extends Types.Entity>(handle: StoreHandle<T>, patches: Patch[], inversePatches: Patch[], options?: Types.StoreOperationOptions) => Promise<void>
}>

export type RuntimePersistence = Readonly<{
    register: (key: Types.WriteStrategy, descriptor: StrategyDescriptor) => () => void
    setDefaultStrategy: (key: Types.WriteStrategy) => () => void
    resolveWritePolicy: (key?: Types.WriteStrategy) => WritePolicy
    persist: <T extends Types.Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}>

export type CoreRuntime = Readonly<{
    id: string
    now: () => number
    stores: StoreRegistry
    hooks: RuntimeHookRegistry
    io: RuntimeIo
    read: RuntimeRead
    write: RuntimeWrite
    persistence: RuntimePersistence
    transform: RuntimeTransform
}>

export type { StoreHandle, StoreStateWriterApi }
