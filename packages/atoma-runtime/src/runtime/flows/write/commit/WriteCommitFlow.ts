import type {
    Entity,
    StoreChange,
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
} from '../types'

type CommitSession<T extends Entity> = Readonly<{
    runtime: WriteCommitRequest<T>['runtime']
    handle: WriteCommitRequest<T>['handle']
    context: WriteCommitRequest<T>['context']
    route?: WriteCommitRequest<T>['route']
    signal?: WriteCommitRequest<T>['signal']
}>

function createEmptyOptimisticState<T extends Entity>(before: Map<EntityId, T>): OptimisticState<T> {
    return {
        before,
        after: before,
        changedIds: new Set<EntityId>(),
        changes: []
    }
}

function applyOptimisticState<T extends Entity>(args: {
    handle: StoreHandle<T>
    plan: WritePlan<T>
    consistency: WriteConsistency
    preserve: (existing: T | undefined, incoming: T) => T
}): OptimisticState<T> {
    const { handle, plan, consistency, preserve } = args
    const before = handle.state.getSnapshot() as Map<EntityId, T>
    if (consistency.commit !== 'optimistic' || !plan.length) {
        return createEmptyOptimisticState(before)
    }

    const optimistic = handle.state.mutate((draft) => {
        plan.forEach(({ entry, optimistic: optimisticEntry }) => {
            const id = optimisticEntry.id
            if (!id) return

            if (entry.action === 'delete') {
                draft.delete(id)
                return
            }

            const value = optimisticEntry.value
            if (value === undefined) return

            const current = draft.get(id)
            const preserved = preserve(current, value)
            if (draft.has(id) && current === preserved) return
            draft.set(id, preserved)
        })
    })

    if (!optimistic) {
        return createEmptyOptimisticState(before)
    }

    return {
        before,
        after: optimistic.after,
        changedIds: optimistic.changedIds,
        changes: optimistic.changes
    }
}

function invertChanges<T extends Entity>(changes: ReadonlyArray<StoreChange<T>>): StoreChange<T>[] {
    return changes.map((change) => ({
        id: change.id,
        ...(change.after !== undefined ? { before: change.after } : {}),
        ...(change.before !== undefined ? { after: change.before } : {})
    }))
}

function mergeChanges<T extends Entity>(...groups: ReadonlyArray<ReadonlyArray<StoreChange<T>>>): StoreChange<T>[] {
    const order: EntityId[] = []
    const merged = new Map<EntityId, { before: T | undefined; after: T | undefined }>()

    groups.forEach((group) => {
        group.forEach((change) => {
            const id = change.id
            const current = merged.get(id)
            if (!current) {
                order.push(id)
                merged.set(id, {
                    before: change.before,
                    after: change.after
                })
                return
            }

            current.after = change.after
        })
    })

    return order.map((id) => {
        const change = merged.get(id)
        if (!change) return { id } as StoreChange<T>
        return {
            id,
            ...(change.before !== undefined ? { before: change.before } : {}),
            ...(change.after !== undefined ? { after: change.after } : {})
        }
    })
}

function rollbackOptimisticState<T extends Entity>(handle: StoreHandle<T>, optimisticState: OptimisticState<T>) {
    if (!optimisticState.changes.length) return
    handle.state.applyChanges(invertChanges(optimisticState.changes))
}

function toExecutionOptions<T extends Entity>(session: CommitSession<T>) {
    return {
        ...(session.route !== undefined ? { route: session.route } : {}),
        ...(session.signal ? { signal: session.signal } : {})
    }
}

async function resolveWriteResult<T extends Entity>(args: {
    session: CommitSession<T>
    plan: WritePlan<T>
    results: ReadonlyArray<WriteItemResult>
    primaryPlan?: WritePlanEntry<T>
}): Promise<{ writeback?: StoreWritebackArgs<T>; output?: T }> {
    const { session, plan, results, primaryPlan } = args
    if (!plan.length || !results.length) return {}

    const resultByEntryId = new Map<string, WriteItemResult>()
    for (const itemResult of results) {
        if (typeof itemResult.entryId !== 'string' || !itemResult.entryId) {
            throw new Error('[Atoma] write item result missing entryId')
        }
        resultByEntryId.set(itemResult.entryId, itemResult)
    }

    const upserts: T[] = []
    const versionUpdates: Array<{ id: EntityId; version: number }> = []
    let output: T | undefined

    const primary = primaryPlan
        ? {
            action: primaryPlan.entry.action,
            id: primaryPlan.optimistic.id
        }
        : undefined

    for (const planEntry of plan) {
        const { entry, optimistic } = planEntry
        const itemResult = resultByEntryId.get(entry.entryId)
        if (!itemResult) {
            throw new Error(`[Atoma] missing write item result for entryId=${entry.entryId}`)
        }

        if (!itemResult.ok) throw toWriteItemError(entry.action, itemResult)

        if (typeof itemResult.version === 'number' && Number.isFinite(itemResult.version) && itemResult.version > 0) {
            const fallbackId = entry.item.id
            const id = itemResult.id ?? optimistic.id ?? fallbackId
            if (id) {
                versionUpdates.push({ id, version: itemResult.version })
            }
        }

        if (!shouldApplyReturnedData(entry) || !itemResult.data || typeof itemResult.data !== 'object') continue

        const normalized = await session.runtime.transform.writeback(session.handle, itemResult.data as T)
        if (!normalized) continue

        upserts.push(normalized)
        if (!output && primary && entry.action === primary.action) {
            if (!primary.id || optimistic.id === primary.id) {
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
    return primaryPlan.optimistic.value
}

function applyWriteback<T extends Entity>(
    handle: WriteCommitRequest<T>['handle'],
    writeback?: StoreWritebackArgs<T>
): ReadonlyArray<StoreChange<T>> {
    if (!writeback) return []
    const applied = handle.state.applyWriteback(writeback)
    if (!applied) return []
    return applied.changes
}

function ensureWriteResultStatus(writeResult: WriteOutput<any>) {
    if (writeResult.status === 'rejected') {
        if (writeResult.results?.length) return
        throw new Error('[Atoma] execution.write rejected without item results')
    }

    if (writeResult.status === 'partial') {
        if (writeResult.results?.length) return
        throw new Error('[Atoma] execution.write partial without item results')
    }
}

async function runWriteTransaction<T extends Entity>(args: {
    session: CommitSession<T>
    plan: WritePlan<T>
    primaryPlan?: WritePlanEntry<T>
}): Promise<{ output?: T; changes: ReadonlyArray<StoreChange<T>> }> {
    const { session, plan, primaryPlan } = args
    if (!plan.length) {
        return {
            output: fallbackPrimaryOutput(primaryPlan),
            changes: []
        }
    }

    const writeResult = await session.runtime.execution.write(
        {
            handle: session.handle,
            context: session.context,
            entries: plan.map((entry) => entry.entry)
        },
        toExecutionOptions(session)
    )
    ensureWriteResultStatus(writeResult)

    const resolved = (writeResult.results && writeResult.results.length)
        ? await resolveWriteResult({
            session,
            plan,
            results: writeResult.results,
            primaryPlan
        })
        : {}

    return {
        output: resolved.output ?? fallbackPrimaryOutput(primaryPlan),
        changes: applyWriteback(session.handle, resolved.writeback)
    }
}

function resolveSession<T extends Entity>(request: WriteCommitRequest<T>): CommitSession<T> {
    return {
        runtime: request.runtime,
        handle: request.handle,
        context: request.context,
        route: request.route,
        signal: request.signal
    }
}

export class WriteCommitFlow {
    execute = async <T extends Entity>(request: WriteCommitRequest<T>): Promise<WriteCommitResult<T>> => {
        const session = resolveSession(request)
        const consistency = session.runtime.execution.resolveConsistency(session.route)
        const optimisticState = applyOptimisticState({
            handle: session.handle,
            plan: request.plan,
            consistency,
            preserve: session.runtime.engine.mutation.preserveRef
        })
        const primaryPlan = resolvePrimaryPlan(request.plan)

        try {
            const transaction = await runWriteTransaction({
                session,
                plan: request.plan,
                primaryPlan
            })

            return {
                changes: mergeChanges(optimisticState.changes, transaction.changes),
                ...(transaction.output !== undefined ? { output: transaction.output } : {})
            }
        } catch (error) {
            rollbackOptimisticState(session.handle, optimisticState)
            throw error
        }
    }
}
