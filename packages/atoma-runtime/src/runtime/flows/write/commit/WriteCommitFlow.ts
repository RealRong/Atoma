import type {
    Entity,
    StoreWritebackArgs,
} from 'atoma-types/core'
import type {
    EntityId,
    WriteAction,
    WriteEntry,
    WriteItemResult
} from 'atoma-types/protocol'
import type {
    StoreHandle,
    Policy
} from 'atoma-types/runtime'
import type { WriteCommitRequest, OptimisticState, WritePlan, WritePlanEntry } from '../types'

function applyOptimistically<T extends Entity>(
    baseState: Map<EntityId, T>,
    plan: WritePlan<T>,
    preserve: (existing: T | undefined, incoming: T) => T
): { afterState: Map<EntityId, T> } {
    let nextState = baseState

    const ensureMutableState = () => {
        if (nextState === baseState) {
            nextState = new Map(baseState)
        }
        return nextState
    }

    const upsert = (id: EntityId, value: T) => {
        const currentState = nextState === baseState ? baseState : nextState
        const current = currentState.get(id)
        const preserved = preserve(current, value)
        if (currentState.has(id) && current === preserved) return
        ensureMutableState().set(id, preserved)
    }

    const remove = (id: EntityId) => {
        const currentState = nextState === baseState ? baseState : nextState
        if (!currentState.has(id)) return
        ensureMutableState().delete(id)
    }

    for (const planEntry of plan) {
        const entityId = planEntry.optimistic.entityId
        if (!entityId) continue

        if (planEntry.entry.action === 'delete') {
            remove(entityId as EntityId)
            continue
        }

        if (planEntry.optimistic.value !== undefined) {
            upsert(entityId as EntityId, planEntry.optimistic.value as T)
        }
    }

    return { afterState: nextState }
}

function applyOptimisticState<T extends Entity>(args: {
    handle: StoreHandle<T>
    plan: WritePlan<T>
    writePolicy: Policy
    preserve: (existing: T | undefined, incoming: T) => T
}): OptimisticState<T> {
    const { handle, plan, writePolicy, preserve } = args
    const beforeState = handle.state.getSnapshot() as Map<EntityId, T>
    const shouldOptimistic = writePolicy.optimistic !== false

    const optimistic = (shouldOptimistic && plan.length)
        ? applyOptimistically(beforeState, plan, preserve)
        : { afterState: beforeState }

    const { afterState } = optimistic
    if (afterState !== beforeState) {
        handle.state.commit({
            before: beforeState,
            after: afterState
        })
    }

    return {
        beforeState,
        afterState
    }
}

function rollbackOptimisticState<T extends Entity>(args: {
    handle: StoreHandle<T>
    optimisticState: OptimisticState<T>
}) {
    const { handle, optimisticState } = args
    if (optimisticState.afterState !== optimisticState.beforeState) {
        handle.state.commit({
            before: optimisticState.afterState,
            after: optimisticState.beforeState
        })
    }
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

function toWriteItemError(action: WriteAction, result: WriteItemResult): Error {
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

async function runWriteTransaction<T extends Entity>(args: {
    request: WriteCommitRequest<T>
    primaryPlan?: WritePlanEntry<T>
    writeEntries: ReadonlyArray<WriteEntry>
}): Promise<T | void> {
    const { request, primaryPlan, writeEntries } = args
    const { runtime, handle, opContext, plan } = request

    if (!writeEntries.length) {
        return fallbackPrimaryOutput(primaryPlan)
    }

    const writeResult = await runtime.strategy.write({
        storeName: String(handle.storeName),
        writeStrategy: request.writeStrategy,
        handle,
        opContext,
        writeEntries
    })

    const resolved = (writeResult.results && writeResult.results.length)
        ? await resolveWriteResultFromWriteOutput<T>({
            runtime,
            handle,
            plan,
            results: writeResult.results,
            primaryPlan
        })
        : {}

    if (resolved.writeback) {
        handle.state.applyWriteback(resolved.writeback)
    }

    return resolved.output ?? fallbackPrimaryOutput(primaryPlan)
}

export class WriteCommitFlow {
    execute = async <T extends Entity>(args: WriteCommitRequest<T>): Promise<T | void> => {
        const plan = args.plan
        const writePolicy = args.runtime.strategy.resolvePolicy(args.writeStrategy)
        const optimisticState = applyOptimisticState({
            handle: args.handle,
            plan,
            writePolicy,
            preserve: args.runtime.engine.mutation.preserveRef
        })

        const primaryPlan = resolvePrimaryPlan(plan)
        const writeEntries = plan.map(entry => entry.entry)

        try {
            return await runWriteTransaction({
                request: args,
                primaryPlan,
                writeEntries
            })
        } catch (error) {
            rollbackOptimisticState({
                handle: args.handle,
                optimisticState
            })
            throw error
        }
    }
}
