import type {
    Entity,
    StoreChange,
    StoreWritebackArgs,
    WriteManyResult,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import { mergeChanges } from 'atoma-core/store'
import type { WriteScope } from '../types'

export type ReconcileWriteResult<T extends Entity> = Readonly<{
    changes: ReadonlyArray<StoreChange<T>>
    rollbackOptimistic: boolean
}>

export function reconcileWriteResult<T extends Entity>({
    scope,
    results,
    optimisticChanges,
    upserts,
    versionUpdates
}: {
    scope: WriteScope<T>
    results: WriteManyResult<T | void>
    optimisticChanges: ReadonlyArray<StoreChange<T>>
    upserts: T[]
    versionUpdates: Array<{ id: EntityId; version: number }>
}): ReconcileWriteResult<T> {
    const writeback: StoreWritebackArgs<T> | undefined = (upserts.length || versionUpdates.length)
        ? {
            ...(upserts.length ? { upserts } : {}),
            ...(versionUpdates.length ? { versionUpdates } : {})
        }
        : undefined
    const transactionChanges = writeback
        ? (scope.handle.state.writeback(writeback)?.changes ?? [])
        : []

    const failed = results.some(item => item && !item.ok)
    return {
        changes: failed
            ? transactionChanges
            : mergeChanges(optimisticChanges, transactionChanges),
        rollbackOptimistic: failed && optimisticChanges.length > 0
    }
}
