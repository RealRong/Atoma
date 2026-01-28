import type { Entity, JotaiStore, OpsClientLike, Persistence, PersistRequest, PersistResult, RuntimeIo, StoreDataProcessor, WriteStrategy } from '#core'
import { MutationPipeline } from '#core'
import { executeLocalQuery } from '#core/query'
import { executeWriteOps } from '#core/mutation/pipeline/WriteOps'
import { createRuntimeIo } from '#core/runtime'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import type { EntityId, Query } from '#protocol'
import type { StoreHandle } from '#core/store/internals/handleTypes'
import type { AtomaSchema } from '#client/types'
import type { ClientRuntimeInternal } from '#client/internal/types'
import { DataProcessor } from '#core/store/internals/dataProcessor'
import { ClientRuntimeObservability } from '#client/internal/runtime/ClientRuntimeObservability'
import { ClientRuntimeStores } from '#client/internal/runtime/ClientRuntimeStores'
import type { PersistHandler } from '#client/types/plugin'
import { ClientRuntimeInternalEngine } from '#client/internal/runtime/ClientRuntimeInternalEngine'
import { Protocol } from '#protocol'

export class ClientRuntime implements ClientRuntimeInternal {
    readonly clientId: string
    readonly ownerClient?: () => unknown
    readonly handles: Map<string, StoreHandle<any>>
    readonly toStoreKey: (storeName: import('#core').StoreToken) => string
    readonly opsClient: OpsClientLike
    readonly io: ClientRuntimeInternal['io']
    readonly mutation: MutationPipeline
    readonly dataProcessor: DataProcessor
    readonly jotaiStore: JotaiStore
    readonly stores: ClientRuntimeInternal['stores']
    readonly observability: ClientRuntimeInternal['observability']
    readonly persistence: Persistence
    readonly persistenceRouter: PersistenceRouter
    readonly internal: ClientRuntimeInternal['internal']

    constructor(args: {
        schema: AtomaSchema<any>
        opsClient: OpsClientLike
        dataProcessor?: StoreDataProcessor<any>
        defaults?: {
            idGenerator?: () => EntityId
        }
        mirrorWritebackToStore?: boolean
        localOnly?: boolean
        ownerClient?: () => unknown
    }) {
        // Internal stable id for namespacing store handles within this runtime instance.
        // Note: Use protocol ids (uuid when available) to avoid collisions.
        this.clientId = Protocol.ids.createOpId('client')
        this.ownerClient = args.ownerClient
        this.handles = new Map<string, StoreHandle<any>>()
        this.toStoreKey = (storeName) => `${this.clientId}:${String(storeName)}`

        this.opsClient = args.opsClient
        this.jotaiStore = createJotaiStore()
        this.dataProcessor = new DataProcessor(() => this)
        this.observability = new ClientRuntimeObservability()
        this.io = args.localOnly
            ? createLocalRuntimeIo(() => this as any)
            : createRuntimeIo(() => this as any)
        this.persistenceRouter = createClientRuntimePersistenceRouter(() => this, { localOnly: args.localOnly })
        this.persistence = this.persistenceRouter
        this.mutation = new MutationPipeline(this)
        this.stores = new ClientRuntimeStores(this, {
            schema: args.schema,
            dataProcessor: args.dataProcessor,
            defaults: args.defaults,
            ownerClient: args.ownerClient
        })

        this.internal = new ClientRuntimeInternalEngine(this, {
            mirrorWritebackToStore: args.mirrorWritebackToStore
        })
    }
}

class PersistenceRouter implements Persistence {
    private handlers = new Map<WriteStrategy, PersistHandler>()

    constructor(
        private readonly direct: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
    ) {}

    register = (key: WriteStrategy, handler: PersistHandler) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] persistence.register: key 必填')
        if (this.handlers.has(k)) throw new Error(`[Atoma] persistence.register: key 已存在: ${k}`)
        this.handlers.set(k, handler)
        return () => {
            this.handlers.delete(k)
        }
    }

    persist = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const key = req.writeStrategy
        if (!key || key === 'direct') {
            return await this.direct(req)
        }
        const handler = this.handlers.get(key)
        if (!handler) {
            throw new Error(`[Atoma] persistence: 未注册 writeStrategy="${String(key)}"`)
        }
        return await handler({ req, next: this.direct })
    }
}

function createClientRuntimePersistenceRouter(
    runtime: () => ClientRuntimeInternal,
    opts?: { localOnly?: boolean }
): PersistenceRouter {
    const persistDirect = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        if (opts?.localOnly) {
            return { status: 'confirmed' }
        }
        const normalized = await executeWriteOps<T>({
            clientRuntime: runtime() as any,
            handle: req.handle as any,
            ops: req.writeOps as any,
            context: req.context
        })
        return {
            status: 'confirmed',
            ...(normalized.ack ? { ack: normalized.ack } : {})
        }
    }

    return new PersistenceRouter(persistDirect)
}

function createLocalRuntimeIo(_runtime: () => ClientRuntimeInternal) {
    const executeOps: RuntimeIo['executeOps'] = async () => {
        throw new Error('[Atoma] local-only 模式不支持 ops 执行')
    }

    const query: RuntimeIo['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query
    ) => {
        const map = handle.jotaiStore.get(handle.atom) as Map<EntityId, T>
        const items = Array.from(map.values()) as T[]
        return executeLocalQuery(items as any, query as any)
    }

    const write: RuntimeIo['write'] = async () => {
        throw new Error('[Atoma] local-only 模式不支持 io.write')
    }

    return { executeOps, query, write }
}
