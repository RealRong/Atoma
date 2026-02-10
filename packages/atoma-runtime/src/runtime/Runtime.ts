/**
 * Runtime: Unified entrypoint for read/write flows.
 * - Owns all subsystems (io, strategy, transform, stores).
 * - Exposes runtime.read/runtime.write as the only flow entrypoints.
 */
import type { Entity, StoreDataProcessor } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { createOpId } from 'atoma-types/protocol-tools'
import type {
    Runtime as RuntimeType,
    Debug,
    Engine as EngineType,
    HookRegistry as HookRegistryType,
    Io,
    Read,
    Schema,
    StrategyRegistry as StrategyRegistryType,
    Transform,
    Write,
    StoreCatalog
} from 'atoma-types/runtime'
import { TransformPipeline } from './transform'
import { Stores } from '../store/Stores'
import { HookRegistry } from './registry/HookRegistry'
import { StrategyRegistry } from './registry/StrategyRegistry'
import { ReadFlow } from './flows/ReadFlow'
import { WriteFlow } from './flows/WriteFlow'
import { Engine } from '../engine'
import { Probe } from './debug'

/**
 * Configuration for creating a Runtime.
 */
export interface Options {
    schema: Schema
    io: Io
    dataProcessor?: StoreDataProcessor<Entity>
    defaults?: {
        idGenerator?: () => EntityId
    }
    strategy?: StrategyRegistryType
    now?: () => number
    hooks?: HookRegistryType
    engine?: EngineType
}

export class Runtime implements RuntimeType {
    readonly id: string
    readonly now: () => number
    readonly nextOpId: RuntimeType['nextOpId']
    io: Io
    readonly strategy: StrategyRegistryType
    readonly transform: Transform
    readonly stores: StoreCatalog
    readonly read: Read
    readonly write: Write
    readonly hooks: HookRegistryType
    readonly engine: EngineType
    readonly debug: Debug

    constructor(config: Options) {
        const opSeq = new Map<string, number>()
        this.id = createOpId('client')
        this.now = config.now ?? (() => Date.now())
        this.nextOpId = (storeName: string, prefix: 'q' | 'w') => {
            const key = String(storeName)
            const next = (opSeq.get(key) ?? 0) + 1
            opSeq.set(key, next)
            return `${prefix}_${this.now()}_${next}`
        }

        this.io = config.io
        this.engine = config.engine ?? new Engine()
        this.transform = new TransformPipeline(this)
        this.strategy = config.strategy ?? new StrategyRegistry(this)
        this.hooks = config.hooks ?? new HookRegistry()

        this.stores = new Stores(this, {
            schema: config.schema,
            dataProcessor: config.dataProcessor,
            defaults: config.defaults
        })

        this.debug = new Probe({
            stores: this.stores,
            now: this.now
        })

        this.read = new ReadFlow(this)
        this.write = new WriteFlow(this)
    }
}
