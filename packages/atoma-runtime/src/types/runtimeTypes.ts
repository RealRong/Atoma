import type { DebugConfig, DebugEvent, ObservabilityContext } from 'atoma-observability'
import type { Meta, Operation, OperationResult } from 'atoma-protocol'
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
    StoreReadOptions,
    StoreToken,
    UpsertWriteOptions,
    WriteManyResult,
    WriteStrategy,
    JotaiStore
} from 'atoma-core'
import type { Draft, Patch } from 'immer'
import type { EntityId } from 'atoma-protocol'
import type { StoreHandle } from './handleTypes'
import type { PersistRequest, PersistResult, StrategyDescriptor, WritePolicy } from './persistenceTypes'

export type OpsClientLike = {
    executeOps: (input: {
        ops: Operation[]
        meta: Meta
        signal?: AbortSignal
        context?: ObservabilityContext
    }) => Promise<{
        results: OperationResult[]
        status?: number
    }>
}

export type DataProcessor = Readonly<{
    process: <T>(mode: DataProcessorMode, data: T, context: DataProcessorBaseContext<T> & { dataProcessor?: StoreDataProcessor<T> }) => Promise<T | undefined>
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
}>

/**
 * CoreRuntime：唯一上下文，承载跨 store 能力（read/write/persistence/observability/resolveStore）
 */
export type StoreRegistry = Readonly<{
    resolve: (name: StoreToken) => IStore<any> | undefined
    ensure: (name: StoreToken) => IStore<any>
    list: () => Iterable<IStore<any>>
    onCreated: (listener: (store: IStore<any>) => void, options?: { replay?: boolean }) => () => void
    resolveHandle: (name: StoreToken, tag?: string) => StoreHandle<any>
}>

export interface RuntimeObservability {
    createContext: (storeName: StoreToken, args?: { traceId?: string; explain?: boolean }) => ObservabilityContext
    registerStore?: (args: { storeName: StoreToken; debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }) => void
}

export type RuntimeIo = Readonly<{
    executeOps: (args: { ops: Operation[]; signal?: AbortSignal; context?: ObservabilityContext }) => Promise<OperationResult[]>
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query, context?: ObservabilityContext, signal?: AbortSignal) => Promise<{ data: unknown[]; pageInfo?: any; explain?: any }>
}>

export type RuntimeTransform = Readonly<{
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
}>

export type RuntimeRead = Readonly<{
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>) => Promise<QueryResult<T>>
    queryOne: <T extends Entity>(handle: StoreHandle<T>, query: Query<T>) => Promise<QueryOneResult<T>>
    getMany: <T extends Entity>(handle: StoreHandle<T>, ids: EntityId[], cache?: boolean, options?: StoreReadOptions) => Promise<T[]>
    getOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreReadOptions) => Promise<T | undefined>
    fetchOne: <T extends Entity>(handle: StoreHandle<T>, id: EntityId, options?: StoreReadOptions) => Promise<T | undefined>
    fetchAll: <T extends Entity>(handle: StoreHandle<T>, options?: StoreReadOptions) => Promise<T[]>
    getAll: <T extends Entity>(handle: StoreHandle<T>, filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: StoreReadOptions) => Promise<T[]>
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

export type RuntimePersistence = Readonly<{
    register: (key: WriteStrategy, descriptor: StrategyDescriptor) => () => void
    resolveWritePolicy: (key?: WriteStrategy) => WritePolicy
    persist: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}>

export type CoreRuntime = Readonly<{
    id: string
    now: () => number
    jotaiStore: JotaiStore
    stores: StoreRegistry
    io: RuntimeIo
    read: RuntimeRead
    write: RuntimeWrite
    persistence: RuntimePersistence
    observe: RuntimeObservability
    transform: RuntimeTransform
}>

export type { StoreHandle }
