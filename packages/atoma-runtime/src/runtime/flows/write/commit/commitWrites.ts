import type {
    Entity,
    StoreChange,
    StoreWritebackArgs,
    WriteManyItemErr,
    WriteManyResult,
} from 'atoma-types/core'
import type {
    ExecutionOptions,
    WriteEntry,
    WriteItemResult,
    WriteOutput,
    WriteConsistency
} from 'atoma-types/runtime'
import type { EntityId } from 'atoma-types/shared'
import {
    invertChanges,
    mergeChanges
} from 'atoma-core/store'
import type {
    WriteCommitRequest,
    WriteCommitResult,
} from '../types'

function applyOptimistic<T extends Entity>({
    request,
    consistency
}: {
    request: WriteCommitRequest<T>
    consistency: WriteConsistency
}): ReadonlyArray<StoreChange<T>> {
    if (request.prepared.length !== 1) return []
    if (consistency.commit !== 'optimistic') return []
    const first = request.prepared[0]
    if (!first) return []

    const optimistic = request.scope.handle.state.apply([
        first.optimistic
    ])

    return optimistic?.changes ?? []
}

function rollbackOptimistic<T extends Entity>(
    request: WriteCommitRequest<T>,
    optimisticChanges: ReadonlyArray<StoreChange<T>>
) {
    if (!optimisticChanges.length) return
    request.scope.handle.state.apply(invertChanges(optimisticChanges))
}

function shouldApplyReturnedData(entry: WriteEntry): boolean {
    if (entry.options?.returning === false) return false
    const select = entry.options?.select
    return !(select && Object.keys(select).length > 0)
}

function toWriteItemError(
    action: WriteEntry['action'],
    result: WriteItemResult
): Error {
    if (result.ok) return new Error(`[Atoma] write(${action}) failed`)

    const msg = result.error.message || 'Write failed'
    const error = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ; (error as { error?: unknown }).error = result.error
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
                    ...(current.value !== undefined ? { value: current.value } : {}),
                    ...(typeof current.version === 'number' ? { version: current.version } : {})
                }
            }
            : {})
    }
}

function ensureWriteResultStatus(writeResult: WriteOutput, expectedCount: number) {
    if (writeResult.status === 'enqueued') return
    if (writeResult.results.length !== expectedCount) {
        throw new Error(`[Atoma] execution.write result count mismatch (expected=${expectedCount} actual=${writeResult.results.length})`)
    }
}

function toEnqueuedResults<T extends Entity>(request: WriteCommitRequest<T>): WriteManyResult<T | void> {
    const prepared = request.prepared
    if (!prepared.length) return []
    if (prepared.length !== 1) {
        throw new Error(`[Atoma] execution.write enqueued requires single entry (actual=${prepared.length})`)
    }
    const first = prepared[0]
    if (!first) {
        throw new Error('[Atoma] execution.write enqueued missing prepared write at index=0')
    }

    return [{
        index: 0,
        ok: true,
        value: first.output as T | void
    }]
}

export async function commitWrites<T extends Entity>(request: WriteCommitRequest<T>): Promise<WriteCommitResult<T>> {
    const { runtime, scope, prepared } = request
    const entries = prepared.map((item) => item.entry)

    if (!entries.length) {
        return {
            changes: [],
            results: []
        }
    }

    const { handle, context, route, signal } = scope
    const executionOptions: ExecutionOptions | undefined = (route ?? signal)
        ? { route, signal }
        : undefined
    const consistency = runtime.execution.resolveConsistency(handle, executionOptions)
    const optimisticChanges = applyOptimistic({
        request,
        consistency
    })

    try {
        const writeResult = await runtime.execution.write(
            { handle, context, entries },
            executionOptions
        )
        ensureWriteResultStatus(writeResult, entries.length)

        if (writeResult.status === 'enqueued') {
            return {
                changes: optimisticChanges,
                results: toEnqueuedResults(request)
            }
        }

        const results: WriteManyResult<T | void> = new Array(entries.length)
        const upserts: T[] = []
        const versionUpdates: Array<{ id: EntityId; version: number }> = []

        for (let index = 0; index < entries.length; index++) {
            const preparedWrite = prepared[index]
            const entry = entries[index]
            if (!preparedWrite || !entry) {
                throw new Error(`[Atoma] missing prepared write at index=${index}`)
            }
            const itemResult = writeResult.results[index]
            if (!itemResult) {
                throw new Error(`[Atoma] execution.write missing write item result at index=${index}`)
            }

            if (!itemResult.ok) {
                results[index] = toWriteManyError(entry, itemResult, index)
                continue
            }

            if (typeof itemResult.version === 'number' && Number.isFinite(itemResult.version) && itemResult.version > 0) {
                const id = itemResult.id ?? entry.item.id
                if (id) {
                    versionUpdates.push({ id, version: itemResult.version })
                }
            }

            let output = preparedWrite.output
            if (shouldApplyReturnedData(entry) && itemResult.data && typeof itemResult.data === 'object') {
                const normalized = await runtime.transform.writeback(handle, itemResult.data as T)
                if (normalized) {
                    upserts.push(normalized)
                    output = normalized
                }
            }

            results[index] = {
                index,
                ok: true,
                value: output as T | void
            }
        }

        const writeback: StoreWritebackArgs<T> | undefined = (upserts.length || versionUpdates.length)
            ? {
                ...(upserts.length ? { upserts } : {}),
                ...(versionUpdates.length ? { versionUpdates } : {})
            }
            : undefined
        const transactionChanges = writeback
            ? (handle.state.writeback(writeback)?.changes ?? [])
            : []

        const failed = results.some(item => item && !item.ok)
        const mergedChanges = failed
            ? transactionChanges
            : mergeChanges(optimisticChanges, transactionChanges)

        if (failed && optimisticChanges.length) {
            rollbackOptimistic(request, optimisticChanges)
        }

        return {
            changes: mergedChanges,
            results
        }
    } catch (error) {
        rollbackOptimistic(request, optimisticChanges)
        throw error
    }
}
