import type { ActionContext } from './action'
import type { StoreToken } from './store'

export type ProcessorMode = 'inbound' | 'writeback' | 'outbound'

export type ProcessorContext = Readonly<{
    storeName: StoreToken
    runtime: unknown
    context?: ActionContext
    mode: ProcessorMode
}>

export type ProcessorHandler<T> = (value: T, context: ProcessorContext) => T | undefined | Promise<T | undefined>

export type StoreProcessor<T> = Readonly<{
    inbound?: ProcessorHandler<T>
    writeback?: ProcessorHandler<T>
    outbound?: ProcessorHandler<T>
    validate?: ProcessorHandler<T>
}>
