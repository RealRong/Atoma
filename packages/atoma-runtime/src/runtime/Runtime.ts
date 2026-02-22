/**
 * Runtime: Unified entrypoint for read/write flows.
 * - Owns all subsystems (execution, processor, stores).
 * - Exposes runtime.read/runtime.write flow entrypoints.
 */
import type { Entity, StoreProcessor } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type {
    Runtime as RuntimeType,
    Debug as DebugType,
    ExecutionKernel as ExecutionKernelType,
    Engine as EngineType,
    StoreEventBus as StoreEventBusType,
    Read,
    Schema,
    Processor as ProcessorType,
    Write,
    StoreCatalog
} from 'atoma-types/runtime'
import { Processor } from './Processor'
import { Catalog } from '../store/Catalog'
import { EventBus } from '../store/EventBus'
import { ExecutionKernel } from '../execution/ExecutionKernel'
import { ReadFlow } from './flows/ReadFlow'
import { WriteFlow } from './flows/WriteFlow'
import { Engine } from '../engine'
import { Debug } from './Debug'

/**
 * Configuration for creating a Runtime.
 */
export interface RuntimeConfig {
    id: string
    stores: Readonly<{
        schema: Schema
        createId?: () => EntityId
        processor?: StoreProcessor<Entity>
    }>
}

export class Runtime implements RuntimeType {
    readonly id: string
    readonly now: () => number
    readonly execution: ExecutionKernelType
    readonly processor: ProcessorType
    readonly stores: StoreCatalog
    readonly read: Read
    readonly write: Write
    readonly events: StoreEventBusType
    readonly engine: EngineType
    readonly debug: DebugType

    constructor(config: RuntimeConfig) {
        this.id = String(config.id)
        this.now = () => Date.now()
        this.engine = new Engine()
        this.processor = new Processor(this)
        this.execution = new ExecutionKernel()
        this.events = new EventBus()
        this.stores = new Catalog(this, config.stores)
        this.debug = new Debug(this)
        this.read = new ReadFlow(this)
        this.write = new WriteFlow(this)
    }
}
