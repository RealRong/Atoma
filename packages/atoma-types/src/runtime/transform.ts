import type {
    DataProcessorBaseContext,
    DataProcessorMode,
    Entity,
    OperationContext,
    StoreDataProcessor,
} from '../core'
import type { StoreHandle } from './handle'

export type TransformPipeline = Readonly<{
    process: <T>(
        mode: DataProcessorMode,
        data: T,
        context: DataProcessorBaseContext<T> & { dataProcessor?: StoreDataProcessor<T> }
    ) => Promise<T | undefined>
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, opContext?: OperationContext) => Promise<T | undefined>
}>

export type Transform = Readonly<{
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
}>
