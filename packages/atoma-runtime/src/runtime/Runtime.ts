/**
 * Runtime: Unified entrypoint for read/write flows.
 * - Owns all subsystems (io, strategy, transform, stores).
 * - Exposes runtime.read/runtime.write as the only flow entrypoints.
 */
import type { StoreDataProcessor } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { createOpId } from 'atoma-types/protocol-tools'
import type {
    CoreRuntime,
    RuntimeEngine,
    RuntimeHookRegistry,
    RuntimeIo,
    RuntimeRead,
    RuntimeSchema,
    RuntimeStrategyRegistry,
    RuntimeTransform,
    RuntimeWrite
} from 'atoma-types/runtime'
import { DataProcessor } from './transform'
import { Stores } from '../store'
import { HookRegistry, StrategyRegistry } from './registry'
import { ReadFlow, WriteFlow } from './flows'
import { CoreRuntimeEngine } from '../engine'

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
    strategy?: RuntimeStrategyRegistry
    now?: () => number
    hooks?: RuntimeHookRegistry
    engine?: RuntimeEngine
}

export class Runtime implements CoreRuntime {
    readonly id: string
    readonly now: () => number
    readonly nextOpId: CoreRuntime['nextOpId']
    io: RuntimeIo
    readonly strategy: RuntimeStrategyRegistry
    readonly transform: RuntimeTransform
    readonly stores: CoreRuntime['stores']
    readonly read: RuntimeRead
    readonly write: RuntimeWrite
    readonly hooks: RuntimeHookRegistry
    readonly engine: RuntimeEngine
    private opSeqByStore = new Map<string, number>()

    constructor(config: RuntimeConfig) {
        this.id = createOpId('client')
        this.now = config.now ?? (() => Date.now())
        this.nextOpId = (storeName: string, prefix: 'q' | 'w') => {
            const key = String(storeName)
            const next = (this.opSeqByStore.get(key) ?? 0) + 1
            this.opSeqByStore.set(key, next)
            return `${prefix}_${this.now()}_${next}`
        }

        this.io = config.io
        this.engine = config.engine ?? new CoreRuntimeEngine()
        this.transform = new DataProcessor(this)
        this.strategy = config.strategy ?? new StrategyRegistry(this)
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
