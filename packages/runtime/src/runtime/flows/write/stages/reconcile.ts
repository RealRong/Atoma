import {
    invertChanges,
    mergeChanges
} from 'atoma-core/store'
import type {
    Entity,
    StoreChange,
    WriteManyItemErr,
    WriteManyResult
} from 'atoma-types/core'
import type {
    WriteEntry,
    WriteItemResult
} from 'atoma-types/runtime'
import type { WriteCtx } from '../context'
import {
    ensureEntry,
    ensureChange,
    ensureOutput
} from '../internal/row'

function shouldApplyReturnedData(entry: WriteEntry): boolean {
    if (entry.options?.returning === false) return false
    const select = entry.options?.select
    return !(select && Object.keys(select).length > 0)
}

function toWriteItemError(
    action: WriteEntry['action'],
    result: Extract<WriteItemResult, { ok: false }>
): Error {
    const msg = result.error.message || 'Write failed'
    const error = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ;(error as { error?: unknown }).error = result.error
    return error
}

function toWriteManyError(
    entry: WriteEntry,
    result: Extract<WriteItemResult, { ok: false }>,
    index: number
): WriteManyItemErr {
    const current = result.current
    return {
        index,
        ok: false,
        error: toWriteItemError(entry.action, result),
        ...(current
            ? {
                current: {
                    ...(current.value !== undefined ? { value: current.value } : {})
                }
            }
            : {})
    }
}

export async function reconcile<T extends Entity>(
    ctx: WriteCtx<T>,
    remoteResults?: ReadonlyArray<WriteItemResult>
) {
    const { runtime, scope, rows } = ctx
    const consistency = runtime.execution.getConsistency()
    const optimistic = consistency.commit === 'optimistic'
    const hasRemote = remoteResults !== undefined

    if (!hasRemote) {
        ctx.results = rows.map((row, index) => ({
            index,
            ok: true,
            value: ensureOutput(row, index)
        }))
        ctx.changes = optimistic
            ? ctx.optimisticChanges
            : scope.handle.state.apply(rows.map((row, index) => ensureChange(row, index)))
        ctx.status = 'confirmed'
        return
    }

    const results: WriteManyResult<T | void> = new Array(rows.length)
    const retainedOptimistic: StoreChange<T>[] = []
    const rollbackChanges: StoreChange<T>[] = []
    const reconcileRows: number[] = []
    const reconcileItems: unknown[] = []

    for (const [index, row] of rows.entries()) {
        const entry = ensureEntry(row, index)
        const remoteResult = remoteResults[index]
        if (!remoteResult) {
            throw new Error(`[Atoma] execution.write missing write item result at index=${index}`)
        }

        if (!remoteResult.ok) {
            results[index] = toWriteManyError(entry, remoteResult, index)
            if (row.optimistic) {
                rollbackChanges.push(row.optimistic)
            }
            continue
        }

        if (shouldApplyReturnedData(entry) && remoteResult.data && typeof remoteResult.data === 'object') {
            reconcileRows.push(index)
            reconcileItems.push(remoteResult.data)
        }

        results[index] = {
            index,
            ok: true,
            value: ensureOutput(row, index)
        }
        if (row.optimistic) {
            retainedOptimistic.push(row.optimistic)
        }
    }

    if (rollbackChanges.length) {
        scope.handle.state.apply(invertChanges(rollbackChanges))
    }

    const reconcileResult = reconcileItems.length
        ? await runtime.stores.use<T>(scope.handle.storeName).reconcile(
            {
                mode: 'upsert',
                items: reconcileItems
            },
            {
                context: scope.context
            }
        )
        : {
            changes: [],
            items: [],
            results: []
        }

    for (let index = 0; index < reconcileRows.length; index += 1) {
        const normalized = reconcileResult.results[index]
        if (normalized === undefined) continue
        const rowIndex = reconcileRows[index]
        const current = results[rowIndex]
        if (!current || !current.ok) continue
        current.value = normalized
    }

    ctx.results = results
    if (!retainedOptimistic.length) {
        ctx.changes = reconcileResult.changes
    } else if (!reconcileResult.changes.length) {
        ctx.changes = mergeChanges(retainedOptimistic)
    } else {
        ctx.changes = mergeChanges(retainedOptimistic, reconcileResult.changes)
    }
    if (!optimistic && ctx.status === 'confirmed' && !reconcileResult.changes.length) {
        ctx.changes = []
    }
}
