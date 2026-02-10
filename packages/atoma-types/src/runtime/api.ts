import type { Draft, Patch } from 'immer'
import type {
    DataProcessorBaseContext,
    DataProcessorMode,
    Entity,
    Store,
    IndexSnapshot,
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
import type { Engine } from './engine/api'
import type { HookRegistry } from './hooks'
import type { StoreHandle } from './handle'
import type { PersistRequest, PersistResult, StrategyDescriptor, WritePolicy } from './persistence'

export type TransformPipeline = Readonly<{
    process: <T>(mode: DataProcessorMode, data: T, context: DataProcessorBaseContext<T> & { dataProcessor?: StoreDataProcessor<T> }) => Promise<T | undefined>
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
}>

export type StoreCatalog = Readonly<{
    resolve: (name: StoreToken) => Store<Entity> | undefined
    ensure: (name: StoreToken) => Store<Entity>
    list: () => Iterable<Store<Entity>>
    onCreated: (listener: (store: Store<Entity>) => void, options?: { replay?: boolean }) => () => void
    resolveHandle: (name: StoreToken, tag?: string) => StoreHandle<Entity>
}>

export type Io = Readonly<{
    executeOps: (args: { ops: Operation[]; signal?: AbortSignal }) => Promise<OperationResult[]>
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query, signal?: AbortSignal) => Promise<{ data: unknown[]; pageInfo?: unknown }>
}>

export type Transform = Readonly<{
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
}>

export type Read = Readonly<{
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>) => Promise<QueryResult<T>>
    queryOne: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>) => Promise<QueryOneResult<T>>
    getMany: <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], cache?: boolean) => Promise<T[]>
    getOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId) => Promise<T | undefined>
    fetchOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId) => Promise<T | undefined>
    fetchAll: <T extends Entity>(handle: StoreHandle<T>) => Promise<T[]>
    getAll: <T extends Entity>(handle: StoreHandle<T>, filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean) => Promise<T[]>
}>

export type Write = Readonly<{
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

export type StrategyRegistry = Readonly<{
    register: (key: WriteStrategy, descriptor: StrategyDescriptor) => () => void
    setDefaultStrategy: (key: WriteStrategy) => () => void
    resolveWritePolicy: (key?: WriteStrategy) => WritePolicy
    persist: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}>

export type StoreDebugSnapshot = Readonly<{
    name: string
    count: number
    approxSize: number
    sample: unknown[]
    timestamp: number
}>

export type IndexDebugSnapshot<T extends Entity = Entity> = Readonly<{
    name: string
    indexes: IndexSnapshot<T>[]
    lastQuery?: unknown
    timestamp: number
}>

export type Debug = Readonly<{
    snapshotStore: (storeName: StoreToken) => StoreDebugSnapshot | undefined
    snapshotIndexes: <T extends Entity = Entity>(storeName: StoreToken) => IndexDebugSnapshot<T> | undefined
}>

export type Runtime = Readonly<{
    id: string
    now: () => number
    nextOpId: (storeName: StoreToken, prefix: 'q' | 'w') => string
    stores: StoreCatalog
    hooks: HookRegistry
    io: Io
    read: Read
    write: Write
    strategy: StrategyRegistry
    transform: Transform
    engine: Engine
    debug: Debug
}>

export type { StoreHandle }
