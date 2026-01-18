import type { CoreStore, JotaiStore, OpsClientLike, OutboxEnqueuer, OutboxQueueMode, OutboxRuntime } from '#core'
import { Core, MutationPipeline } from '#core'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import type { EntityId } from '#protocol'
import { Observability } from '#observability'
import type { DebugConfig, DebugEvent } from '#observability'
import { executeMutationFlow } from '../../../core/mutation/pipeline/MutationFlow'
import { createStoreInstance } from './createStore'
import type { AtomaSchema, ClientRuntime } from '../../types'
import type { SyncStore } from '#core'
import { requireStoreHandle } from '../../../core/store/internals/storeAccess'

export function createClientRuntime(args: {
    schema: AtomaSchema<any>
    opsClient: OpsClientLike
    defaults?: {
        idGenerator?: () => EntityId
    }
    syncStore?: {
        queue?: 'queue' | 'local-first'
    }
}): ClientRuntime {
    let runtimeRef: ClientRuntime | null = null

    const mutation = new MutationPipeline({
        execute: async (segment) => {
            if (!runtimeRef) {
                throw new Error('[Atoma] runtime not initialized')
            }
            return await executeMutationFlow(runtimeRef, segment)
        }
    })

    const storeCache = new Map<string, CoreStore<any, any>>()
    const syncStoreCache = new Map<string, SyncStore<any, any>>()
    const jotaiStore: JotaiStore = createJotaiStore()

    const createdStores: CoreStore<any, any>[] = []
    const storeListeners = new Set<(store: CoreStore<any, any>) => void>()

    const notifyStoreCreated = (store: CoreStore<any, any>) => {
        createdStores.push(store)

        for (const listener of storeListeners) {
            try {
                listener(store)
            } catch {
                // ignore
            }
        }
    }

    const onStoreCreated = (listener: (store: CoreStore<any, any>) => void, options?: { replay?: boolean }) => {
        if (options?.replay) {
            for (const store of createdStores) {
                try {
                    listener(store)
                } catch {
                    // ignore
                }
            }
        }
        storeListeners.add(listener)
        return () => {
            storeListeners.delete(listener)
        }
    }

    let outboxRuntime: OutboxRuntime | undefined

    const installOutboxRuntime = (args2: { queueMode: OutboxQueueMode; ensureEnqueuer: () => OutboxEnqueuer }) => {
        outboxRuntime = {
            queueMode: args2.queueMode,
            ensureEnqueuer: args2.ensureEnqueuer
        }
    }

    const observabilityConfigByStore = new Map<string, { debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }>()
    const observabilityByStore = new Map<string, ReturnType<typeof Observability.runtime.create>>()

    const registerStoreObservability = (config: { storeName: string; debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }) => {
        const key = String(config.storeName || 'store')
        observabilityConfigByStore.set(key, { debug: config.debug, debugSink: config.debugSink })
    }

    const getObservabilityRuntime = (storeName: string) => {
        const key = String(storeName || 'store')
        const existing = observabilityByStore.get(key)
        if (existing) return existing

        const config = observabilityConfigByStore.get(key)
        const runtime = Observability.runtime.create({
            scope: key,
            debug: config?.debug,
            onEvent: config?.debugSink
        })
        observabilityByStore.set(key, runtime)
        return runtime
    }

    const createObservabilityContext = (storeName: string, ctxArgs?: { traceId?: string; explain?: boolean }) => {
        return getObservabilityRuntime(storeName).createContext(ctxArgs)
    }

    const getOrCreateStore = (name: string) => {
        if (!runtimeRef) {
            throw new Error('[Atoma] runtime not initialized')
        }

        const key = String(name)
        const existing = storeCache.get(key)
        if (existing) return existing

        const created = createStoreInstance({
            name: key,
            schema: args.schema,
            clientRuntime: runtimeRef,
            defaultIdGenerator: args.defaults?.idGenerator
        })

        storeCache.set(key, created)
        notifyStoreCreated(created)
        return created
    }

    const resolveStore = (name: string) => getOrCreateStore(String(name)) as any

    const clientRuntime: ClientRuntime = {
        opsClient: args.opsClient,
        mutation,
        resolveStore,
        createObservabilityContext,
        registerStoreObservability,
        get outbox() {
            return outboxRuntime
        },
        jotaiStore,
        Store: getOrCreateStore,
        SyncStore: (name: string) => {
            const key = String(name)
            const existing = syncStoreCache.get(key)
            if (existing) return existing

            const base = getOrCreateStore(key)
            const handle = requireStoreHandle(base, `Store.SyncStore:${key}`)

            const view = Core.store.createSyncStoreView(clientRuntime, handle, args.syncStore)
            syncStoreCache.set(key, view as any)
            return view as any
        },
        listStores: () => storeCache.values(),
        onStoreCreated,
        installOutboxRuntime
    }

    runtimeRef = clientRuntime

    return clientRuntime
}
