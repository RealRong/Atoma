import type {
    Entity,
    StoreWritebackArgs,
} from 'atoma-types/core'
import type {
    WriteEntry,
    WriteItemResult,
    WriteOutput,
    StoreHandle,
    WriteConsistency
} from 'atoma-types/runtime'
import type { EntityId } from 'atoma-types/shared'
import type {
    WriteCommitRequest,
    OptimisticState,
    WritePlan,
    WritePlanEntry,
    WriteCommitResult,
    WritePatchPayload
} from '../types'

function applyOptimisticState<T extends Entity>(args: {
    handle: StoreHandle<T>
    plan: WritePlan<T>
    consistency: WriteConsistency
    preserve: (existing: T | undefined, incoming: T) => T
}): OptimisticState<T> {
    const { handle, plan, consistency, preserve } = args
    const before = handle.state.getSnapshot() as Map<EntityId, T>
    if (consistency.commit !== 'optimistic' || !plan.length) {
        return {
            before,
            after: before,
            changedIds: new Set<EntityId>(),
            patches: [],
            inversePatches: []
        }
    }

    const changedIds = new Set<EntityId>(
        plan
            .map((entry) => entry.optimistic.entityId)
            .filter((id): id is EntityId => id !== undefined)
    )
    const optimistic = handle.state.mutate((draft) => {
        for (const planEntry of plan) {
            const entityId = planEntry.optimistic.entityId
            if (!entityId) continue

            if (planEntry.entry.action === 'delete') {
                draft.delete(entityId as EntityId)
                continue
            }

            if (planEntry.optimistic.value === undefined) continue

            const id = entityId as EntityId
            const current = draft.get(id) as T | undefined
            const preserved = preserve(current, planEntry.optimistic.value as T)
            if (draft.has(id) && current === preserved) continue
            draft.set(id, preserved)
        }
    })
    if (!optimistic) {
        return {
            before,
            after: before,
            changedIds,
            patches: [],
            inversePatches: []
        }
    }

    return {
        before,
        after: optimistic.after,
        changedIds,
        patches: optimistic.patches,
        inversePatches: optimistic.inversePatches
    }
}

function rollbackOptimisticState<T extends Entity>(args: {
    handle: StoreHandle<T>
    optimisticState: OptimisticState<T>
}) {
    if (!args.optimisticState.inversePatches.length) return
    args.handle.state.applyPatches(args.optimisticState.inversePatches)
}

async function resolveWriteResultFromWriteOutput<T extends Entity>(args: {
    runtime: WriteCommitRequest<T>['runtime']
    handle: WriteCommitRequest<T>['handle']
    plan: WritePlan<T>
    results: ReadonlyArray<WriteItemResult>
    primaryPlan?: WritePlanEntry<T>
}): Promise<{ writeback?: StoreWritebackArgs<T>; output?: T }> {
    if (!args.plan.length || !args.results.length) return {}

    const resultByEntryId = new Map<string, WriteItemResult>()
    for (const itemResult of args.results) {
        if (typeof itemResult.entryId !== 'string' || !itemResult.entryId) {
            throw new Error('[Atoma] write item result missing entryId')
        }
        resultByEntryId.set(itemResult.entryId, itemResult)
    }

    const upserts: T[] = []
    const versionUpdates: Array<{ key: EntityId; version: number }> = []
    let output: T | undefined

    const primary = args.primaryPlan
        ? {
            action: args.primaryPlan.entry.action,
            entityId: args.primaryPlan.optimistic.entityId
        }
        : undefined

    for (const planEntry of args.plan) {
        const { entry, optimistic } = planEntry
        const itemResult = resultByEntryId.get(entry.entryId)
        if (!itemResult) {
            throw new Error(`[Atoma] missing write item result for entryId=${entry.entryId}`)
        }

        if (!itemResult.ok) throw toWriteItemError(entry.action, itemResult)

        if (typeof itemResult.version === 'number' && Number.isFinite(itemResult.version) && itemResult.version > 0) {
            const fallbackEntityId = (entry.item as any)?.entityId
            const entityId = itemResult.entityId ?? optimistic.entityId ?? fallbackEntityId
            if (entityId) {
                versionUpdates.push({ key: entityId as EntityId, version: itemResult.version })
            }
        }

        if (!shouldApplyReturnedData(entry) || !itemResult.data || typeof itemResult.data !== 'object') continue

        const normalized = await args.runtime.transform.writeback(args.handle, itemResult.data as T)
        if (!normalized) continue

        upserts.push(normalized)
        if (!output && primary && entry.action === primary.action) {
            if (!primary.entityId || optimistic.entityId === primary.entityId) {
                output = normalized
            }
        }
    }

    const writeback = (upserts.length || versionUpdates.length)
        ? ({
            ...(upserts.length ? { upserts } : {}),
            ...(versionUpdates.length ? { versionUpdates } : {})
        } as StoreWritebackArgs<T>)
        : undefined

    return { writeback, output }
}

function shouldApplyReturnedData(entry: WriteEntry): boolean {
    const options = entry.options
    if (!options) return true
    if (options.returning === false) return false

    const select = options.select
    if (select && typeof select === 'object' && Object.keys(select).length > 0) {
        return false
    }

    return true
}

function toWriteItemError(
    action: WriteEntry['action'],
    result: WriteItemResult
): Error {
    if (result.ok) return new Error(`[Atoma] write(${action}) failed`)

    const msg = result.error.message || 'Write failed'
    const error = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ;(error as { error?: unknown }).error = result.error
    return error
}

function resolvePrimaryPlan<T extends Entity>(plan: WritePlan<T>): WritePlanEntry<T> | undefined {
    return plan.length === 1 ? plan[0] : undefined
}

function fallbackPrimaryOutput<T extends Entity>(primaryPlan?: WritePlanEntry<T>): T | undefined {
    if (!primaryPlan) return undefined
    if (primaryPlan.entry.action === 'delete') return undefined
    return primaryPlan.optimistic.value as T | undefined
}

function applyWritebackResult<T extends Entity>(args: {
    handle: WriteCommitRequest<T>['handle']
    writeback?: StoreWritebackArgs<T>
}): {
    patchPayload: WritePatchPayload
} {
    if (!args.writeback) {
        return {
            patchPayload: null
        }
    }

    const writeback = args.handle.state.applyWriteback(args.writeback)
    if (!writeback) {
        return {
            patchPayload: null
        }
    }

    return {
        patchPayload: (!writeback.patches.length && !writeback.inversePatches.length)
            ? null
            : {
                patches: writeback.patches,
                inversePatches: writeback.inversePatches
            }
    }
}

function mergePatchPayload(...payloads: ReadonlyArray<WritePatchPayload>): WritePatchPayload {
    let merged: WritePatchPayload = null
    payloads.forEach((payload) => {
        if (!payload) return
        merged = !merged
            ? payload
            : {
                patches: [...merged.patches, ...payload.patches],
                inversePatches: [...payload.inversePatches, ...merged.inversePatches]
            }
    })
    return merged
}

async function runWriteTransaction<T extends Entity>(args: {
    request: WriteCommitRequest<T>
    primaryPlan?: WritePlanEntry<T>
    entries: ReadonlyArray<WriteEntry>
}): Promise<{ output?: T; patchPayload: WritePatchPayload }> {
    const { request, primaryPlan, entries } = args
    const { runtime, handle, opContext, plan } = request

    if (!entries.length) {
        return {
            output: fallbackPrimaryOutput(primaryPlan),
            patchPayload: null
        }
    }

    const writeResult = await runtime.execution.write(
        {
            handle,
            opContext,
            entries
        },
        {
            ...(request.route !== undefined ? { route: request.route } : {}),
            ...(request.signal ? { signal: request.signal } : {})
        }
    )

    ensureWriteResultStatus({ writeResult })

    const resolved = (writeResult.results && writeResult.results.length)
        ? await resolveWriteResultFromWriteOutput<T>({
            runtime,
            handle,
            plan,
            results: writeResult.results,
            primaryPlan
        })
        : {}

    const writebackResult = applyWritebackResult({
        handle,
        writeback: resolved.writeback
    })

    return {
        output: resolved.output ?? fallbackPrimaryOutput(primaryPlan),
        patchPayload: writebackResult.patchPayload
    }
}

function ensureWriteResultStatus(args: {
    writeResult: WriteOutput<any>
}) {
    const { writeResult } = args
    if (writeResult.status === 'rejected') {
        if (writeResult.results?.length) return
        throw new Error('[Atoma] execution.write rejected without item results')
    }

    if (writeResult.status === 'partial') {
        if (writeResult.results?.length) return
        throw new Error('[Atoma] execution.write partial without item results')
    }
}

export class WriteCommitFlow {
    execute = async <T extends Entity>(args: WriteCommitRequest<T>): Promise<WriteCommitResult<T>> => {
        const plan = args.plan
        const consistency = args.runtime.execution.resolveConsistency(args.route)
        const optimisticState = applyOptimisticState({
            handle: args.handle,
            plan,
            consistency,
            preserve: args.runtime.engine.mutation.preserveRef
        })

        const primaryPlan = resolvePrimaryPlan(plan)
        const entries = plan.map(entry => entry.entry)

        try {
            const transaction = await runWriteTransaction({
                request: args,
                primaryPlan,
                entries
            })

            return {
                patchPayload: args.rawPatchPayload ?? mergePatchPayload(
                    (optimisticState.patches.length || optimisticState.inversePatches.length)
                        ? {
                            patches: optimisticState.patches,
                            inversePatches: optimisticState.inversePatches
                        }
                        : null,
                    transaction.patchPayload
                ),
                ...(transaction.output !== undefined ? { output: transaction.output } : {})
            }
        } catch (error) {
            rollbackOptimisticState({
                handle: args.handle,
                optimisticState
            })
            throw error
        }
    }
}
