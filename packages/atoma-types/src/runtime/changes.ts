import type { Entity, StoreChange, StoreOperationOptions } from '../core'
import type { StoreHandle } from './store/handle'

export type Changes = Readonly<{
    apply: <T extends Entity>(
        handle: StoreHandle<T>,
        changes: ReadonlyArray<StoreChange<T>>,
        options?: StoreOperationOptions
    ) => Promise<void>
    revert: <T extends Entity>(
        handle: StoreHandle<T>,
        changes: ReadonlyArray<StoreChange<T>>,
        options?: StoreOperationOptions
    ) => Promise<void>
}>
