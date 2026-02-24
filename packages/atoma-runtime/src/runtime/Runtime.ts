/**
 * Runtime: Unified entrypoint for read/write flows.
 * - Owns all subsystems (execution, processor, stores).
 * - Exposes runtime.read/runtime.write flow entrypoints.
 */
import type { Entity } from 'atoma-types/core'
import type {
    Runtime as RuntimeType,
    Debug as DebugType,
    Execution as ExecutionType,
    Engine as EngineType,
    StoreEventBus as StoreEventBusType,
    Read,
    StoresConfig,
    Processor as ProcessorType,
    Write,
    StoreCatalog
} from 'atoma-types/runtime'
import { Processor } from './Processor'
import { Catalog } from '../store/Catalog'
import { EventBus } from '../store/EventBus'
import { Execution } from '../execution'
import { ReadFlow } from './flows/ReadFlow'
import { WriteFlow } from './flows/WriteFlow'
import { Engine } from '../engine'
import { Debug } from './Debug'

/**
 * Configuration for creating a Runtime.
 */
export interface RuntimeConfig {
    id: string
    now?: () => number
    stores?: StoresConfig<Record<string, Entity>, object>
}

export class Runtime implements RuntimeType {
    readonly id: string
    readonly now: () => number
    readonly execution: ExecutionType
    readonly processor: ProcessorType
    readonly stores: StoreCatalog
    readonly read: Read
    readonly write: Write
    readonly events: StoreEventBusType
    readonly engine: EngineType
    readonly debug: DebugType

    constructor(config: RuntimeConfig) {
        this.id = String(config.id)
        this.now = config.now ?? (() => Date.now())
        this.engine = new Engine({ now: this.now })
        this.processor = new Processor(this)
        this.execution = new Execution()
        this.events = new EventBus()
        this.stores = new Catalog(this, config.stores)
        this.debug = new Debug(this)
        this.read = new ReadFlow(this)
        this.write = new WriteFlow(this)
    }
}
