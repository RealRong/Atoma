/**
 * ClientRuntime: The core runtime for Atoma client.
 * - Owns all subsystems (io, write, mutation, persistence, observe, transform, stores, internal).
 * - Implements ClientRuntimeInternal interface.
 */
import type {
    JotaiStore,
    OpsClientLike,
    RuntimeIo,
    RuntimeMutation,
    RuntimeObservability,
    RuntimePersistence,
    RuntimeTransform,
    RuntimeWrite,
    StoreDataProcessor
} from '#core'
import type { EntityId } from '#protocol'
import type { AtomaSchema } from '#client/types'
import { Protocol } from '#protocol'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { MutationPipeline } from '#core'
import { createRuntimeIo } from '#core/runtime'
import { DataProcessor } from '#core/store/internals/dataProcessor'
import { createLocalRuntimeIo } from './io/RuntimeIoLocal'
import { PersistenceRouter } from './persistence'
import { ClientRuntimeObservability } from './ClientRuntimeObservability'
import { ClientRuntimeStores } from './ClientRuntimeStores'
import { StoreWriteCoordinator } from './StoreWriteCoordinator'
import { ClientRuntimeInternalEngine } from './ClientRuntimeInternalEngine'
import type { ClientRuntimeInternal } from '#client/internal/types'

/**
 * Configuration for creating a ClientRuntime.
 */
export interface ClientRuntimeConfig {
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
}

/**
 * Creates an id using Protocol.ids.createOpId.
 */
function createRuntimeId(): string {
    return Protocol.ids.createOpId('client')
}

export class ClientRuntime implements ClientRuntimeInternal {
    readonly id: string
    readonly now: () => number
    readonly ownerClient?: () => unknown
    readonly jotaiStore: JotaiStore
    readonly io: RuntimeIo
    readonly write: RuntimeWrite
    readonly mutation: RuntimeMutation
    readonly persistence: RuntimePersistence
    readonly observe: RuntimeObservability
    readonly transform: RuntimeTransform
    readonly stores: ClientRuntimeInternal['stores']
    readonly internal: ClientRuntimeInternal['internal']

    constructor(config: ClientRuntimeConfig) {
        // Basic properties
        this.id = createRuntimeId()
        this.now = config.now ?? (() => Date.now())
        this.ownerClient = config.ownerClient

        // Jotai store for reactive state
        this.jotaiStore = createJotaiStore()

        // Observability (no dependencies)
        this.observe = new ClientRuntimeObservability()

        // Transform/DataProcessor (needs runtime reference)
        this.transform = new DataProcessor(() => this)

        // Mutation pipeline (needs runtime reference)
        const mutationPipeline = new MutationPipeline(this)
        this.mutation = mutationPipeline

        // Write coordinator (needs runtime and mutation dispatch)
        this.write = new StoreWriteCoordinator(this, mutationPipeline.dispatch)

        // IO (local or remote)
        this.io = config.localOnly
            ? createLocalRuntimeIo()
            : createRuntimeIo({
                opsClient: config.opsClient,
                transform: this.transform,
                now: this.now
            })

        // Persistence router
        this.persistence = new PersistenceRouter({
            getRuntimeAndHandle: (req) => ({
                runtime: this,
                handle: req.handle
            }),
            localOnly: config.localOnly
        })

        // Stores registry
        this.stores = new ClientRuntimeStores(this, {
            schema: config.schema,
            dataProcessor: config.dataProcessor,
            defaults: config.defaults,
            ownerClient: config.ownerClient
        })

        // Internal engine
        this.internal = new ClientRuntimeInternalEngine(this, {
            mirrorWritebackToStore: config.mirrorWritebackToStore,
            now: this.now
        })
    }
}
