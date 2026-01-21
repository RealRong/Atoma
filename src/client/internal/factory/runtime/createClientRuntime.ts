import type { JotaiStore, OpsClientLike, OutboxWriter, StoreDataProcessor } from '#core'
import { MutationPipeline } from '#core'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import type { EntityId } from '#protocol'
import type { AtomaSchema } from '#client/types'
import { storeHandleManager } from '#core/store/internals/storeHandleManager'
import { RuntimeStoreWriteEngine } from '#core/store/internals/storeWriteEngine'
import type { ClientRuntimeInternal } from '#client/internal/types'
import { DataProcessor } from '#core/store/internals/dataProcessor'
import { ClientRuntimeObservability } from '#client/internal/factory/runtime/ClientRuntimeObservability'
import { ClientRuntimeStores } from '#client/internal/factory/runtime/ClientRuntimeStores'

export class ClientRuntime implements ClientRuntimeInternal {
    readonly opsClient: OpsClientLike
    readonly mutation: MutationPipeline
    readonly dataProcessor: DataProcessor
    readonly jotaiStore: JotaiStore
    readonly stores: ClientRuntimeInternal['stores']
    readonly observability: ClientRuntimeInternal['observability']
    readonly internal: ClientRuntimeInternal['internal']
    readonly outbox?: OutboxWriter

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
        outbox?: OutboxWriter
    }) {
        this.opsClient = args.opsClient
        this.jotaiStore = createJotaiStore()
        this.mutation = new MutationPipeline(this)
        this.dataProcessor = new DataProcessor(() => this)
        this.observability = new ClientRuntimeObservability()
        this.stores = new ClientRuntimeStores(this, {
            schema: args.schema,
            dataProcessor: args.dataProcessor,
            defaults: args.defaults,
            syncStore: args.syncStore
        })

        const storeWriteEngine = new RuntimeStoreWriteEngine(this, this.stores.Store, storeHandleManager)
        this.outbox = args.outbox

        this.internal = storeWriteEngine
    }
}
