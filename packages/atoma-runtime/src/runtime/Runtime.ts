/**
 * Runtime: Unified entrypoint for read/write flows.
 * - Owns all subsystems (io, persistence, transform, stores).
 * - Exposes runtime.read/runtime.write as the only flow entrypoints.
 */
import type { JotaiStore, StoreDataProcessor } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { Protocol } from 'atoma-protocol'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import type { CoreRuntime, RuntimeHookRegistry, RuntimeIo, RuntimePersistence, RuntimeRead, RuntimeSchema, RuntimeTransform, RuntimeWrite } from 'atoma-types/runtime'
import { DataProcessor } from './transform'
import { Stores } from '../store'
import { HookRegistry, StrategyRegistry } from './registry'
import { ReadFlow, WriteFlow } from './flows'

/**
 * Configuration for creating a Runtime.
 */
export interface RuntimeConfig {
    schema: RuntimeSchema
    io: RuntimeIo
    dataProcessor?: StoreDataProcessor<any>
    defaults?: {
        idGenerator?: () => EntityId
    }
    persistence?: RuntimePersistence
    now?: () => number
    hooks?: RuntimeHookRegistry
}

export class Runtime implements CoreRuntime {
    readonly id: string
    readonly now: () => number
    readonly jotaiStore: JotaiStore
    io: RuntimeIo
    readonly persistence: RuntimePersistence
    readonly transform: RuntimeTransform
    readonly stores: CoreRuntime['stores']
    readonly read: RuntimeRead
    readonly write: RuntimeWrite
    readonly hooks: RuntimeHookRegistry

    constructor(config: RuntimeConfig) {
        this.id = Protocol.ids.createOpId('client')
        this.now = config.now ?? (() => Date.now())
        this.jotaiStore = createJotaiStore()

        this.io = config.io
        this.transform = new DataProcessor(this)
        this.persistence = config.persistence ?? new StrategyRegistry(this)
        this.hooks = config.hooks ?? new HookRegistry()

        this.stores = new Stores(this, {
            schema: config.schema,
            dataProcessor: config.dataProcessor,
            defaults: config.defaults
        })

        this.read = new ReadFlow(this)
        this.write = new WriteFlow(this)
    }
}
