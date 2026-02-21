import type {
    Entity,
    StoreChange,
    StoreWritebackArgs,
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
    if (consistency.commit !== 'optimistic') return []

    const optimistic = request.scope.handle.state.apply([
        request.prepared.optimisticChange
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

async function resolveResult<T extends Entity>({
    request,
    entry,
    result
}: {
    request: WriteCommitRequest<T>
    entry: WriteEntry
    result: WriteItemResult
}): Promise<{ writeback?: StoreWritebackArgs<T>; output?: T }> {
    if (!result.ok) throw toWriteItemError(entry.action, result)

    const upserts: T[] = []
    const versionUpdates: Array<{ id: EntityId; version: number }> = []

    if (typeof result.version === 'number' && Number.isFinite(result.version) && result.version > 0) {
        const id = result.id ?? entry.item.id
        if (id) {
            versionUpdates.push({ id, version: result.version })
        }
    }

    let output: T | undefined
    if (shouldApplyReturnedData(entry) && result.data && typeof result.data === 'object') {
        const normalized = await request.runtime.transform.writeback(
            request.scope.handle,
            result.data as T
        )
        if (normalized) {
            upserts.push(normalized)
            output = normalized
        }
    }

    const writeback: StoreWritebackArgs<T> | undefined =
        (upserts.length || versionUpdates.length)
            ? { upserts, versionUpdates }
            : undefined

    return { writeback, output }
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

function ensureWriteResultStatus(writeResult: WriteOutput) {
    if (writeResult.status === 'enqueued') return
    if (writeResult.results.length !== 1) {
        throw new Error(`[Atoma] execution.write result count mismatch (expected=1 actual=${writeResult.results.length})`)
    }
}

export async function commitWrite<T extends Entity>(request: WriteCommitRequest<T>): Promise<WriteCommitResult<T>> {
    const { runtime, scope, prepared } = request
    const { handle, context, route, signal } = scope
    const entry = prepared.entry
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
            { handle, context, entries: [entry] },
            executionOptions
        )
        ensureWriteResultStatus(writeResult)

        if (writeResult.status === 'enqueued') {
            return {
                changes: optimisticChanges
            }
        }

        const itemResult = writeResult.results[0]
        if (!itemResult) {
            throw new Error('[Atoma] execution.write missing write item result at index=0')
        }

        const resolved = await resolveResult({
            request,
            entry,
            result: itemResult
        })

        const transactionChanges = resolved.writeback
            ? (handle.state.writeback(resolved.writeback)?.changes ?? [])
            : []

        return {
            changes: mergeChanges(optimisticChanges, transactionChanges),
            ...(resolved.output !== undefined ? { output: resolved.output } : {})
        }
    } catch (error) {
        rollbackOptimistic(request, optimisticChanges)
        throw error
    }
}
