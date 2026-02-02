/**
 * Runtime: Unified entrypoint for read/write flows.
 * - Owns all subsystems (io, persistence, observe, transform, stores).
 * - Exposes runtime.read/runtime.write as the only flow entrypoints.
 */
import type { Runtime as CoreRuntimeTypes, Types } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import { Protocol } from 'atoma-protocol'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import type { CoreRuntime, RuntimeIo, RuntimeObservability, RuntimePersistence, RuntimeRead, RuntimeTransform, RuntimeWrite } from '../types/runtimeTypes'
import { DataProcessor } from './transform/DataProcessor'
import { Stores } from '../store/Stores'
import { StoreObservability } from 'atoma-observability'
import { StrategyRegistry } from './StrategyRegistry'
import { ReadFlow } from './read/ReadFlow'
import { WriteFlow } from './write/WriteFlow'

/**
 * Configuration for creating a Runtime.
 */
export interface RuntimeConfig {
    schema: CoreRuntimeTypes.RuntimeSchema
    io?: RuntimeIo
    dataProcessor?: Types.StoreDataProcessor<any>
    defaults?: {
        idGenerator?: () => EntityId
    }
    persistence?: RuntimePersistence
    observe?: RuntimeObservability
    ownerClient?: () => unknown
    now?: () => number
}

export class Runtime implements CoreRuntime {
    readonly id: string
    readonly now: () => number
    readonly ownerClient?: () => unknown
    readonly jotaiStore: Types.JotaiStore
    io: RuntimeIo
    readonly persistence: RuntimePersistence
    readonly observe: RuntimeObservability
    readonly transform: RuntimeTransform
    readonly stores: CoreRuntime['stores']
    readonly read: RuntimeRead
    readonly write: RuntimeWrite

    constructor(config: RuntimeConfig) {
        this.id = Protocol.ids.createOpId('client')
        this.now = config.now ?? (() => Date.now())
        this.ownerClient = config.ownerClient

        this.jotaiStore = createJotaiStore()

        this.observe = config.observe ?? new StoreObservability()
        this.transform = new DataProcessor(() => this)

        if (config.io) {
            this.io = config.io
        } else {
            throw new Error('[Atoma] Runtime: io 必填')
        }

        this.persistence = config.persistence ?? new StrategyRegistry(this)

        this.stores = new Stores(this, {
            schema: config.schema,
            dataProcessor: config.dataProcessor,
            defaults: config.defaults,
            ownerClient: config.ownerClient
        })

        this.read = new ReadFlow(this)
        this.write = new WriteFlow(this)
    }
}
