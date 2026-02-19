/**
 * Runtime: Unified entrypoint for read/write flows.
 * - Owns all subsystems (execution, transform, stores).
 * - Exposes runtime.read/runtime.write as the only flow entrypoints.
 */
import type { Entity, StoreDataProcessor } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type {
    Runtime as RuntimeType,
    Debug,
    ExecutionKernel as ExecutionKernelType,
    Engine as EngineType,
    StoreEventRegistry as StoreEventRegistryType,
    Read,
    Schema,
    Transform,
    Write,
    StoreCatalog
} from 'atoma-types/runtime'
import { TransformPipeline } from './transform/TransformPipeline'
import { Stores } from '../store/Stores'
import { StoreEventRegistry } from './registry/StoreEventRegistry'
import { ExecutionKernel } from '../execution/ExecutionKernel'
import { ReadFlow } from './flows/ReadFlow'
import { WriteFlow } from './flows/WriteFlow'
import { Engine } from '../engine'
import { Probe } from './debug/Probe'

/**
 * Configuration for creating a Runtime.
 */
export interface Options {
    id: string
    schema: Schema
    dataProcessor?: StoreDataProcessor<Entity>
    defaults?: {
        idGenerator?: () => EntityId
    }
    execution?: ExecutionKernelType
    now?: () => number
    events?: StoreEventRegistryType
    engine?: EngineType
}

export class Runtime implements RuntimeType {
    readonly id: string
    readonly now: () => number
    readonly execution: ExecutionKernelType
    readonly transform: Transform
    readonly stores: StoreCatalog
    readonly read: Read
    readonly write: Write
    readonly events: StoreEventRegistryType
    readonly engine: EngineType
    readonly debug: Debug

    constructor(config: Options) {
        this.id = String(config.id)
        this.now = config.now ?? (() => Date.now())

        this.engine = config.engine ?? new Engine()
        this.transform = new TransformPipeline(this)
        this.execution = config.execution ?? new ExecutionKernel()
        this.events = config.events ?? new StoreEventRegistry()

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
