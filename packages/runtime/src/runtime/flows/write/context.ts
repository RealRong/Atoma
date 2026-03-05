import type {
    Entity,
    StoreChange,
    WriteManyResult
} from '@atoma-js/types/core'
import type {
    Runtime,
    WriteEntry,
    WriteOutput
} from '@atoma-js/types/runtime'
import type {
    IntentCommand,
    WriteScope
} from './contracts'

export type Row<T extends Entity> = {
    intent: IntentCommand<T>
    intentId?: string
    base?: T
    change?: StoreChange<T>
    entry?: WriteEntry
    optimistic?: StoreChange<T>
}

export type WriteCtx<T extends Entity> = {
    runtime: Runtime
    scope: WriteScope<T>
    rows: Row<T>[]
    optimisticChanges: ReadonlyArray<StoreChange<T>>
    status: WriteOutput['status']
    results: WriteManyResult<T | void>
    changes: ReadonlyArray<StoreChange<T>>
}

export function createContext<T extends Entity>(args: {
    runtime: Runtime
    scope: WriteScope<T>
}): WriteCtx<T> {
    return {
        ...args,
        rows: [],
        optimisticChanges: [],
        status: 'confirmed',
        results: [],
        changes: []
    }
}
