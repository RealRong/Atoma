import type { Draft, Patch } from 'immer'
import type {
    DataProcessorBaseContext,
    DataProcessorMode,
    Entity,
    IStore,
    OperationContext,
    PartialWithId,
    Query,
    QueryOneResult,
    QueryResult,
    StoreDataProcessor,
    StoreOperationOptions,
    StoreToken,
    UpsertWriteOptions,
    WriteManyResult,
    WriteStrategy,
} from '../core'
import type { Operation, OperationResult } from '../protocol'
import type { EntityId } from '../shared'
import type { RuntimeEngine } from './engine/api'
import type { RuntimeHookRegistry } from './hooks'
import type { StoreHandle } from './handle'
import type { PersistRequest, PersistResult, StrategyDescriptor, WritePolicy } from './persistence'

export type DataProcessor = Readonly<{
    process: <T>(mode: DataProcessorMode, data: T, context: DataProcessorBaseContext<T> & { dataProcessor?: StoreDataProcessor<T> }) => Promise<T | undefined>
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
}>

export type StoreRegistry = Readonly<{
    resolve: (name: StoreToken) => IStore<Entity> | undefined
    ensure: (name: StoreToken) => IStore<Entity>
    list: () => Iterable<IStore<Entity>>
    onCreated: (listener: (store: IStore<Entity>) => void, options?: { replay?: boolean }) => () => void
    resolveHandle: (name: StoreToken, tag?: string) => StoreHandle<Entity>
}>

export type RuntimeIo = Readonly<{
    executeOps: (args: { ops: Operation[]; signal?: AbortSignal }) => Promise<OperationResult[]>
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query, signal?: AbortSignal) => Promise<{ data: unknown[]; pageInfo?: unknown }>
}>

export type RuntimeTransform = Readonly<{
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
}>

export type RuntimeRead = Readonly<{
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>) => Promise<QueryResult<T>>
    queryOne: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>) => Promise<QueryOneResult<T>>
    getMany: <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], cache?: boolean) => Promise<T[]>
    getOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId) => Promise<T | undefined>
    fetchOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId) => Promise<T | undefined>
    fetchAll: <T extends Entity>(handle: StoreHandle<T>) => Promise<T[]>
    getAll: <T extends Entity>(handle: StoreHandle<T>, filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean) => Promise<T[]>
}>

export type RuntimeWrite = Readonly<{
    addOne: <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, options?: StoreOperationOptions) => Promise<T>
    addMany: <T extends Entity>(handle: StoreHandle<T>, items: Array<Partial<T>>, options?: StoreOperationOptions) => Promise<T[]>
    updateOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions) => Promise<T>
    updateMany: <T extends Entity>(handle: StoreHandle<T>, items: Array<{ id: EntityId; recipe: (draft: Draft<T>) => void }>, options?: StoreOperationOptions) => Promise<WriteManyResult<T>>
    upsertOne: <T extends Entity>(handle: StoreHandle<T>, item: PartialWithId<T>, options?: StoreOperationOptions & UpsertWriteOptions) => Promise<T>
    upsertMany: <T extends Entity>(handle: StoreHandle<T>, items: Array<PartialWithId<T>>, options?: StoreOperationOptions & UpsertWriteOptions) => Promise<WriteManyResult<T>>
    deleteOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreOperationOptions) => Promise<boolean>
    deleteMany: <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], options?: StoreOperationOptions) => Promise<WriteManyResult<boolean>>
    patches: <T extends Entity>(handle: StoreHandle<T>, patches: Patch[], inversePatches: Patch[], options?: StoreOperationOptions) => Promise<void>
}>

export type RuntimeStrategyRegistry = Readonly<{
    register: (key: WriteStrategy, descriptor: StrategyDescriptor) => () => void
    setDefaultStrategy: (key: WriteStrategy) => () => void
    resolveWritePolicy: (key?: WriteStrategy) => WritePolicy
    persist: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}>

export type CoreRuntime = Readonly<{
    id: string
    now: () => number
    nextOpId: (storeName: StoreToken, prefix: 'q' | 'w') => string
    stores: StoreRegistry
    hooks: RuntimeHookRegistry
    io: RuntimeIo
    read: RuntimeRead
    write: RuntimeWrite
    strategy: RuntimeStrategyRegistry
    transform: RuntimeTransform
    engine: RuntimeEngine
}>

export type { StoreHandle }
