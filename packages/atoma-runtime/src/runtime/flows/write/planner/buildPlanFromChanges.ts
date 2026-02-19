import { createIdempotencyKey, ensureWriteItemMeta, requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
import type { Entity, ActionContext, StoreChange } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle, WriteEntry, WriteItemMeta, WriteOptions } from 'atoma-types/runtime'
import type { WritePlan, WritePlanEntry, WritePlanPolicy } from '../types'

function buildUpsertWriteOptions(policy?: WritePlanPolicy): WriteOptions | undefined {
    if (!policy) return undefined

    const writeOptions: WriteOptions = {}
    if (typeof policy.merge === 'boolean') {
        writeOptions.merge = policy.merge
    }
    if (policy.upsertMode === 'strict' || policy.upsertMode === 'loose') {
        writeOptions.upsert = { mode: policy.upsertMode }
    }

    return Object.keys(writeOptions).length
        ? writeOptions
        : undefined
}

function createWriteItemMeta(now: () => number): WriteItemMeta {
    return ensureWriteItemMeta({
        meta: {
            idempotencyKey: createIdempotencyKey({ now }),
            clientTimeMs: now()
        },
        now
    })
}

function createPlanEntry<T extends Entity>({
    id,
    entry,
    value
}: {
    id: EntityId
    entry: WriteEntry
    value?: T
}): WritePlanEntry<T> {
    return {
        entry,
        optimistic: {
            id,
            ...(value !== undefined ? { next: value } : {})
        }
    }
}

function requireChangeBefore<T extends Entity>({
    change,
    action
}: {
    change: StoreChange<T>
    action: WriteEntry['action']
}): T {
    const before = change.before
    if (before !== undefined) return before

    throw new Error(
        `[Atoma] buildPlanFromChanges: ${action} action requires base value (id=${String(change.id)})`
    )
}

type WritePlanFromChangesInput<T extends Entity> = {
    runtime: Runtime
    handle: StoreHandle<T>
    context: ActionContext
    changes: ReadonlyArray<StoreChange<T>>
    policy?: WritePlanPolicy
    createEntryId: () => string
}

export async function buildPlanFromChanges<T extends Entity>({
    runtime,
    handle,
    context,
    changes,
    policy,
    createEntryId
}: WritePlanFromChangesInput<T>): Promise<WritePlan<T>> {
    if (!changes.length) return []

    const plan: WritePlanEntry<T>[] = []
    const virtual = new Map(handle.state.getSnapshot() as Map<EntityId, T>)
    const upsertWriteOptions = buildUpsertWriteOptions(policy)

    for (const change of changes) {
        const id = change.id
        const before = change.before
        const after = change.after
        const action = policy?.action ?? (after === undefined ? 'delete' : 'upsert')
        const meta = createWriteItemMeta(runtime.now)
        const current = virtual.get(id)

        if (action === 'delete') {
            if (after !== undefined) {
                throw new Error(`[Atoma] buildPlanFromChanges: delete action requires empty target (id=${String(id)})`)
            }
            const baseVersion = requireBaseVersion(id, requireChangeBefore({ change, action }))

            plan.push(createPlanEntry({
                id,
                entry: {
                    entryId: createEntryId(),
                    action: 'delete',
                    item: {
                        id,
                        baseVersion,
                        meta
                    }
                }
            }))
            virtual.delete(id)
            continue
        }

        if (after === undefined) {
            throw new Error(`[Atoma] buildPlanFromChanges: ${action} action requires target value (id=${String(id)})`)
        }
        if (after.id !== id) {
            throw new Error(`[Atoma] buildPlanFromChanges: target id mismatch (change.id=${String(id)} target.id=${String(after.id)})`)
        }

        const outbound = await runtime.transform.outbound(handle, after, context)
        if (outbound === undefined) {
            throw new Error('[Atoma] transform returned empty for outbound write')
        }

        const entryId = createEntryId()
        const updateBaseVersion = action === 'update'
            ? requireBaseVersion(id, requireChangeBefore({ change, action }))
            : undefined
        const upsertBaseVersion = action === 'upsert'
            ? resolvePositiveVersion(current ?? before ?? after)
            : undefined

        const entry: WriteEntry = action === 'create'
            ? {
                entryId,
                action: 'create',
                item: {
                    id,
                    value: outbound,
                    meta
                }
            }
            : action === 'update'
                ? {
                    entryId,
                    action: 'update',
                    item: {
                        id,
                        baseVersion: updateBaseVersion as number,
                        value: outbound,
                        meta
                    }
                }
                : {
                    entryId,
                    action: 'upsert',
                    item: {
                        id,
                        ...(typeof upsertBaseVersion === 'number' ? { baseVersion: upsertBaseVersion } : {}),
                        value: outbound,
                        meta
                    },
                    ...(upsertWriteOptions ? { options: upsertWriteOptions } : {})
                }

        plan.push(createPlanEntry({ id, entry, value: after }))
        virtual.set(id, after)
    }

    return plan
}
