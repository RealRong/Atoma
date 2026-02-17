import type {
    DataProcessorBaseContext,
    DataProcessorMode,
    Entity,
    ActionContext,
    StoreDataProcessor,
} from '../core'
import type { StoreHandle } from './handle'

export type TransformPipeline = Readonly<{
    process: <T>(
        mode: DataProcessorMode,
        data: T,
        context: DataProcessorBaseContext<T> & { dataProcessor?: StoreDataProcessor<T> }
    ) => Promise<T | undefined>
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, context?: ActionContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, context?: ActionContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, context?: ActionContext) => Promise<T | undefined>
}>

export type Transform = Readonly<{
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, context?: ActionContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, context?: ActionContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, context?: ActionContext) => Promise<T | undefined>
}>
