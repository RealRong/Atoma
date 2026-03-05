import { applySteps } from '@atoma-js/core/store'
import type {
    Entity,
    StoreChange
} from '@atoma-js/types/core'
import type {
    WriteItemResult,
    WriteOutput
} from '@atoma-js/types/runtime'
import type { EntityId } from '@atoma-js/types/shared'
import type { WriteCtx } from '../context'
import {
    ensureChange,
    ensureEntry
} from '../internal/row'

function ensureWriteResultStatus(writeResult: WriteOutput, expectedCount: number) {
    if (writeResult.results.length !== expectedCount) {
        throw new Error(`[Atoma] execution.write result count mismatch (expected=${expectedCount} actual=${writeResult.results.length})`)
    }
}

export async function commit<T extends Entity>(
    ctx: WriteCtx<T>
): Promise<ReadonlyArray<WriteItemResult> | undefined> {
    const { runtime, scope, rows } = ctx
    const consistency = runtime.execution.getConsistency()
    const optimistic = consistency.commit === 'optimistic'

    if (optimistic) {
        const allChanges = rows.map((row, index) => ensureChange(row, index))
        const needDuplicateCheck = rows.some((row) => row.intentId === undefined)
        const hasDuplicateId = needDuplicateCheck
            ? (() => {
                const seenIds = new Set<string>()
                return allChanges.some((change) => {
                    const id = String(change.id)
                    if (seenIds.has(id)) return true
                    seenIds.add(id)
                    return false
                })
            })()
            : false

        if (!hasDuplicateId) {
            const applied = scope.handle.state.apply(allChanges)
            const byId = new Map<string, StoreChange<T>>()
            applied.forEach((change) => {
                byId.set(String(change.id), change)
            })
            rows.forEach((row, index) => {
                row.optimistic = byId.get(String(allChanges[index].id))
            })
            ctx.optimisticChanges = applied
        } else {
            const stepped = applySteps({
                before: scope.handle.state.snapshot() as Map<EntityId, T>,
                changes: allChanges
            })
            rows.forEach((row, index) => {
                row.optimistic = stepped.steps[index]
            })
            ctx.optimisticChanges = stepped.changes.length
                ? scope.handle.state.apply(stepped.changes)
                : []
        }
    }

    if (!runtime.execution.hasExecutor('write')) {
        ctx.status = 'confirmed'
        return undefined
    }

    const entries = rows.map((row, index) => ensureEntry(row, index))
    const writeResult = await runtime.execution.write(
        {
            handle: scope.handle,
            context: scope.context,
            entries
        },
        scope.signal ? { signal: scope.signal } : undefined
    )
    ensureWriteResultStatus(writeResult, entries.length)
    ctx.status = writeResult.status
    return writeResult.results
}
