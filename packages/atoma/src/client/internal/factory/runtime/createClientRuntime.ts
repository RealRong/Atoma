import type { Entity, JotaiStore, OpsClientLike, Persistence, PersistRequest, PersistResult, StoreDataProcessor, WriteStrategy } from '#core'
import { MutationPipeline } from '#core'
import { executeWriteOps } from '#core/mutation/pipeline/WriteOps'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import type { EntityId } from '#protocol'
import type { AtomaSchema } from '#client/types'
import { storeHandleManager } from '#core/store/internals/storeHandleManager'
import { RuntimeStoreWriteEngine } from '#core/store/internals/storeWriteEngine'
import type { ClientRuntimeInternal } from '#client/internal/types'
import { DataProcessor } from '#core/store/internals/dataProcessor'
import { ClientRuntimeObservability } from '#client/internal/factory/runtime/ClientRuntimeObservability'
import { ClientRuntimeStores } from '#client/internal/factory/runtime/ClientRuntimeStores'
import type { PersistHandler } from '#client/types/plugin'

export class ClientRuntime implements ClientRuntimeInternal {
    readonly opsClient: OpsClientLike
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
    }) {
        this.opsClient = args.opsClient
        this.jotaiStore = createJotaiStore()
        this.dataProcessor = new DataProcessor(() => this)
        this.observability = new ClientRuntimeObservability()
        this.persistenceRouter = createClientRuntimePersistenceRouter(() => this)
        this.persistence = this.persistenceRouter
        this.mutation = new MutationPipeline(this)
        this.stores = new ClientRuntimeStores(this, {
            schema: args.schema,
            dataProcessor: args.dataProcessor,
            defaults: args.defaults
        })

        const storeWriteEngine = new RuntimeStoreWriteEngine(this, this.stores.Store, storeHandleManager)

        this.internal = storeWriteEngine
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
    runtime: () => ClientRuntimeInternal
): PersistenceRouter {
    const persistDirect = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const normalized = await executeWriteOps<T>({
            clientRuntime: runtime() as any,
            handle: req.handle as any,
            ops: req.writeOps as any,
            context: req.context
        })
        return {
            status: 'confirmed',
            ...(normalized.created ? { created: normalized.created } : {}),
            ...(normalized.writeback ? { writeback: normalized.writeback } : {})
        }
    }

    return new PersistenceRouter(persistDirect)
}
