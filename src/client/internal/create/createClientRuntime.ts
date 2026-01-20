import type { CoreStore, JotaiStore, OpsClientLike, OutboxRuntime, StoreDataProcessor } from '#core'
import { Core, MutationPipeline } from '#core'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import type { EntityId } from '#protocol'
import { Observability } from '#observability'
import type { DebugConfig, DebugEvent } from '#observability'
import { createStoreInstance } from './createStore'
import type { AtomaSchema } from '../../types'
import type { SyncStore } from '#core'
import { storeHandleManager } from '../../../core/store/internals/storeHandleManager'
import { RuntimeStoreWriteEngine } from '../../../core/store/internals/storeWriteEngine'
import type { ClientRuntimeInternal } from '../types'
import { DataProcessor } from '../../../core/store/internals/dataProcessor'

type StoreListener = (store: CoreStore<any, any>) => void
const toStoreKey = (name: unknown) => String(name)
const toStoreScope = (name?: string) => String(name || 'store')

class ObservabilityRegistry {
    private observabilityConfigByStore = new Map<string, { debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }>()
    private observabilityByStore = new Map<string, ReturnType<typeof Observability.runtime.create>>()

    registerStoreObservability = (config: { storeName: string; debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }) => {
        const key = toStoreScope(config.storeName)
        this.observabilityConfigByStore.set(key, { debug: config.debug, debugSink: config.debugSink })
    }

    createObservabilityContext = (storeName: string, ctxArgs?: { traceId?: string; explain?: boolean }) => {
        return this.getObservabilityRuntime(storeName).createContext(ctxArgs)
    }

    private getObservabilityRuntime = (storeName: string) => {
        const key = toStoreScope(storeName)
        const existing = this.observabilityByStore.get(key)
        if (existing) return existing

        const config = this.observabilityConfigByStore.get(key)
        const runtime = Observability.runtime.create({
            scope: key,
            debug: config?.debug,
            onEvent: config?.debugSink
        })
        this.observabilityByStore.set(key, runtime)
        return runtime
    }
}

class StoreRegistry {
    private storeCache = new Map<string, CoreStore<any, any>>()
    private syncStoreCache = new Map<string, SyncStore<any, any>>()
    private createdStores: CoreStore<any, any>[] = []
    private storeListeners = new Set<StoreListener>()

    constructor(
        private runtime: ClientRuntimeInternal,
        private args: {
            schema: AtomaSchema<any>
            dataProcessor?: StoreDataProcessor<any>
            defaults?: {
                idGenerator?: () => EntityId
            }
            syncStore?: {
                queue?: 'queue' | 'local-first'
            }
        }
    ) {}

    getOrCreateStore = (name: string) => {
        const key = toStoreKey(name)
        const existing = this.storeCache.get(key)
        if (existing) return existing

        const created = createStoreInstance({
            name: key,
            schema: this.args.schema,
            clientRuntime: this.runtime,
            defaultIdGenerator: this.args.defaults?.idGenerator,
            defaultDataProcessor: this.args.dataProcessor
        })

        this.storeCache.set(key, created)
        this.notifyStoreCreated(created)
        return created
    }

    resolveStore = (name: string) => this.getOrCreateStore(toStoreKey(name)) as any

    getOrCreateSyncStore = (name: string) => {
        const key = toStoreKey(name)
        const existing = this.syncStoreCache.get(key)
        if (existing) return existing

        const base = this.getOrCreateStore(key)
        const handle = storeHandleManager.requireStoreHandle(base, `Store.SyncStore:${key}`)

        const view = Core.store.createSyncStoreView(this.runtime, handle, this.args.syncStore)
        this.syncStoreCache.set(key, view as any)
        return view as any
    }

    listStores = () => this.storeCache.values()

    onStoreCreated = (listener: StoreListener, options?: { replay?: boolean }) => {
        if (options?.replay) {
            for (const store of this.createdStores) {
                try {
                    listener(store)
                } catch {
                    // ignore
                }
            }
        }
        this.storeListeners.add(listener)
        return () => {
            this.storeListeners.delete(listener)
        }
    }

    private notifyStoreCreated = (store: CoreStore<any, any>) => {
        this.createdStores.push(store)
        for (const listener of this.storeListeners) {
            try {
                listener(store)
            } catch {
                // ignore
            }
        }
    }
}

export class ClientRuntime implements ClientRuntimeInternal {
    readonly opsClient: OpsClientLike
    readonly mutation: MutationPipeline
    readonly dataProcessor: DataProcessor
    readonly resolveStore: ClientRuntimeInternal['resolveStore']
    readonly createObservabilityContext: ClientRuntimeInternal['createObservabilityContext']
    readonly registerStoreObservability: ClientRuntimeInternal['registerStoreObservability']
    readonly jotaiStore: JotaiStore
    readonly Store: ClientRuntimeInternal['Store']
    readonly SyncStore: ClientRuntimeInternal['SyncStore']
    readonly listStores: ClientRuntimeInternal['listStores']
    readonly onStoreCreated: ClientRuntimeInternal['onStoreCreated']
    readonly internal: ClientRuntimeInternal['internal']
    readonly outbox?: OutboxRuntime

    private readonly storeRegistry: StoreRegistry
    private readonly observabilityRegistry: ObservabilityRegistry
    private readonly storeWriteEngine: RuntimeStoreWriteEngine

    constructor(args: {
        schema: AtomaSchema<any>
        opsClient: OpsClientLike
        dataProcessor?: StoreDataProcessor<any>
        defaults?: {
            idGenerator?: () => EntityId
        }
        syncStore?: {
            queue?: 'queue' | 'local-first'
        }
        outbox?: OutboxRuntime
    }) {
        this.opsClient = args.opsClient
        this.jotaiStore = createJotaiStore()
        this.mutation = new MutationPipeline(this)
        this.dataProcessor = new DataProcessor(() => this)
        this.observabilityRegistry = new ObservabilityRegistry()
        this.storeRegistry = new StoreRegistry(this, {
            schema: args.schema,
            dataProcessor: args.dataProcessor,
            defaults: args.defaults,
            syncStore: args.syncStore
        })
        this.storeWriteEngine = new RuntimeStoreWriteEngine(this, this.storeRegistry.getOrCreateStore, storeHandleManager)
        this.outbox = args.outbox

        this.resolveStore = this.storeRegistry.resolveStore
        this.createObservabilityContext = this.observabilityRegistry.createObservabilityContext
        this.registerStoreObservability = this.observabilityRegistry.registerStoreObservability
        this.Store = this.storeRegistry.getOrCreateStore
        this.SyncStore = this.storeRegistry.getOrCreateSyncStore
        this.listStores = this.storeRegistry.listStores
        this.onStoreCreated = this.storeRegistry.onStoreCreated
        this.internal = {
            getStoreSnapshot: this.storeWriteEngine.getStoreSnapshot,
            applyWriteback: this.storeWriteEngine.applyWriteback,
            dispatchPatches: this.storeWriteEngine.dispatchPatches
        }
    }
}
