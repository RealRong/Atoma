import type {
    Entity,
    JotaiStore,
    OpsClientLike,
    PersistRequest,
    PersistResult,
    RuntimeIo,
    RuntimePersistence,
    StoreDataProcessor,
    WriteStrategy
} from '#core'
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
import type { PersistHandler } from '#core'
import { ClientRuntimeInternalEngine } from '#client/internal/runtime/ClientRuntimeInternalEngine'
import { Protocol } from '#protocol'
import { StoreWriteCoordinator } from '#client/internal/runtime/StoreWriteCoordinator'

export class ClientRuntime implements ClientRuntimeInternal {
    readonly id: string
    readonly now: () => number
    readonly ownerClient?: () => unknown
    readonly io: ClientRuntimeInternal['io']
    readonly write: ClientRuntimeInternal['write']
    readonly mutation: ClientRuntimeInternal['mutation']
    readonly persistence: ClientRuntimeInternal['persistence']
    readonly observe: ClientRuntimeInternal['observe']
    readonly transform: ClientRuntimeInternal['transform']
    readonly jotaiStore: JotaiStore
    readonly stores: ClientRuntimeInternal['stores']
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
        now?: () => number
    }) {
        // Internal stable id for namespacing store handles within this runtime instance.
        // Note: Use protocol ids (uuid when available) to avoid collisions.
        this.id = Protocol.ids.createOpId('client')
        this.now = args.now ?? (() => Date.now())
        this.ownerClient = args.ownerClient

        this.jotaiStore = createJotaiStore()

        this.observe = new ClientRuntimeObservability()
        this.transform = new DataProcessor(() => this)

        const mutationPipeline = new MutationPipeline(this)
        this.mutation = mutationPipeline
        this.write = new StoreWriteCoordinator(this, mutationPipeline.dispatch)

        this.io = args.localOnly
            ? createLocalRuntimeIo()
            : createRuntimeIo({
                opsClient: args.opsClient,
                transform: this.transform,
                now: this.now
            })

        this.persistence = createClientRuntimePersistenceRouter(() => this, { localOnly: args.localOnly })

        this.stores = new ClientRuntimeStores(this, {
            schema: args.schema,
            dataProcessor: args.dataProcessor,
            defaults: args.defaults,
            ownerClient: args.ownerClient
        })

        this.internal = new ClientRuntimeInternalEngine(this, {
            mirrorWritebackToStore: args.mirrorWritebackToStore,
            now: this.now
        })
    }
}

class PersistenceRouter implements RuntimePersistence {
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
): RuntimePersistence {
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

function createLocalRuntimeIo(): RuntimeIo {
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
