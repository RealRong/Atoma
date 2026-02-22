import type {
    Entity,
    ActionContext,
} from '../core'
import type { StoreHandle } from './store/handle'

export type Processor = Readonly<{
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, context?: ActionContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, context?: ActionContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, context?: ActionContext) => Promise<T | undefined>
}>
