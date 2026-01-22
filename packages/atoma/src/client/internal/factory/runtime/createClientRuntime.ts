import type { Entity, JotaiStore, OpsClientLike, Persistence, PersistRequest, PersistResult, StoreDataProcessor } from '#core'
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
import type { OutboxWriter as SyncOutboxWriter } from 'atoma-sync'
import type { OutboxWrite } from 'atoma-sync'
import type { WriteAction, WriteItem, WriteOptions } from '#protocol'

export class ClientRuntime implements ClientRuntimeInternal {
    readonly opsClient: OpsClientLike
    readonly mutation: MutationPipeline
    readonly dataProcessor: DataProcessor
    readonly jotaiStore: JotaiStore
    readonly stores: ClientRuntimeInternal['stores']
    readonly observability: ClientRuntimeInternal['observability']
    readonly persistence: Persistence
    readonly internal: ClientRuntimeInternal['internal']

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
        sync?: {
            outboxWriter?: SyncOutboxWriter
        }
    }) {
        this.opsClient = args.opsClient
        this.jotaiStore = createJotaiStore()
        this.dataProcessor = new DataProcessor(() => this)
        this.observability = new ClientRuntimeObservability()
        this.persistence = createClientRuntimePersistence(() => this, args.sync?.outboxWriter)
        this.mutation = new MutationPipeline(this)
        this.stores = new ClientRuntimeStores(this, {
            schema: args.schema,
            dataProcessor: args.dataProcessor,
            defaults: args.defaults,
            syncStore: args.syncStore
        })

        const storeWriteEngine = new RuntimeStoreWriteEngine(this, this.stores.Store, storeHandleManager)

        this.internal = storeWriteEngine
    }
}

function createClientRuntimePersistence(
    runtime: () => ClientRuntimeInternal,
    outboxWriter?: SyncOutboxWriter
): Persistence {
    const requireOutbox = () => {
        if (!outboxWriter) {
            throw new Error('[Atoma] persistence: sync outbox 未配置（sync 未安装或未启用 outbox）')
        }
        return outboxWriter
    }

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

    const persistEnqueueOnly = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const outbox = requireOutbox()
        const writes = mapTranslatedWriteOpsToOutboxWrites(req.writeOps)
        if (writes.length) await outbox.enqueueWrites({ writes })
        return { status: 'enqueued' }
    }

    const persistLocalFirst = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const outbox = requireOutbox()
        const direct = await persistDirect(req)
        const writes = mapTranslatedWriteOpsToOutboxWrites(req.writeOps)
        if (writes.length) await outbox.enqueueWrites({ writes })
        return { status: 'enqueued', ...(direct.created ? { created: direct.created } : {}), ...(direct.writeback ? { writeback: direct.writeback } : {}) }
    }

    return {
        persist: async <T extends Entity>(req: PersistRequest<T>) => {
            const key = req.persistKey
            if (!key || key === 'direct') {
                return persistDirect(req)
            }
            if (key === 'sync:queue') {
                return persistEnqueueOnly(req)
            }
            if (key === 'sync:local-first') {
                return persistLocalFirst(req)
            }
            throw new Error(`[Atoma] persistence: 未知 persistKey="${String(key)}"`)
        }
    }
}

function mapTranslatedWriteOpsToOutboxWrites(writeOps: PersistRequest<any>['writeOps']): OutboxWrite[] {
    const out: OutboxWrite[] = []
    for (const w of writeOps) {
        const op: any = w.op
        if (!op || op.kind !== 'write') {
            throw new Error('[Atoma] sync outbox: 仅支持 write op（TranslatedWriteOp.op.kind 必须为 "write"）')
        }

        const write: any = op.write
        const resource = String(write?.resource ?? '')
        const action = write?.action as WriteAction
        const options = (write?.options && typeof write.options === 'object') ? (write.options as WriteOptions) : undefined
        const items: WriteItem[] = Array.isArray(write?.items) ? (write.items as WriteItem[]) : []
        if (!resource || !action || items.length !== 1) {
            throw new Error('[Atoma] sync outbox: write op 必须包含 resource/action 且只能有 1 个 item')
        }

        const item = items[0] as any
        const meta = item?.meta
        if (!meta || typeof meta !== 'object') {
            throw new Error('[Atoma] sync outbox: write item meta 必填（需要 idempotencyKey/clientTimeMs）')
        }
        if (typeof meta.idempotencyKey !== 'string' || !meta.idempotencyKey) {
            throw new Error('[Atoma] sync outbox: write item meta.idempotencyKey 必填')
        }
        if (typeof meta.clientTimeMs !== 'number' || !Number.isFinite(meta.clientTimeMs)) {
            throw new Error('[Atoma] sync outbox: write item meta.clientTimeMs 必填')
        }

        out.push({
            resource,
            action,
            item: item as WriteItem,
            ...(options ? { options } : {})
        })
    }
    return out
}
