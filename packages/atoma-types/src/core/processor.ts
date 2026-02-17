import type { ActionContext } from './action'
import type { StoreToken } from './store'

/**
 * Schema validator support (works with Zod/Yup or custom functions)
 */
export type SchemaValidator<T> =
    | ((data: T) => T | Promise<T>)
    | {
        parse: (data: unknown) => T
    }
    | {
        safeParse: (data: unknown) => { success: boolean; data: T; error?: unknown }
    }
    | {
        validateSync: (data: unknown) => T
    }
    | {
        validate: (data: unknown) => Promise<T> | T
    }

export type DataProcessorMode = 'inbound' | 'writeback' | 'outbound'

export type DataProcessorStage = 'deserialize' | 'normalize' | 'transform' | 'validate' | 'sanitize' | 'serialize'

export type DataProcessorBaseContext<T> = Readonly<{
    storeName: StoreToken
    runtime: unknown
    context?: ActionContext
    adapter?: unknown
}>

export type DataProcessorContext<T> = DataProcessorBaseContext<T> & Readonly<{
    mode: DataProcessorMode
    stage: DataProcessorStage
}>

export type DataProcessorStageFn<T> = (value: T, context: DataProcessorContext<T>) => T | undefined | Promise<T | undefined>

export type DataProcessorValidate<T> = SchemaValidator<T> | DataProcessorStageFn<T>

export type StoreDataProcessor<T> = Readonly<{
    deserialize?: DataProcessorStageFn<T>
    normalize?: DataProcessorStageFn<T>
    transform?: DataProcessorStageFn<T>
    validate?: DataProcessorValidate<T>
    sanitize?: DataProcessorStageFn<T>
    serialize?: DataProcessorStageFn<T>
}>
