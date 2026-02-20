import { createIdempotencyKey, ensureWriteItemMeta, requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
import type { Entity, ActionContext, StoreChange } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle, WriteEntry, WriteItemMeta } from 'atoma-types/runtime'
import type { WritePlan, WritePlanEntry, WritePlanPolicy } from '../types'

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
        `[Atoma] buildPlan: ${action} action requires base value (id=${String(change.id)})`
    )
}

type BuildPlanInput<T extends Entity> = {
    runtime: Runtime
    handle: StoreHandle<T>
    context: ActionContext
    changes: ReadonlyArray<StoreChange<T>>
    policy?: WritePlanPolicy
    createEntryId: () => string
}

export async function buildPlan<T extends Entity>({
    runtime,
    handle,
    context,
    changes,
    policy,
    createEntryId
}: BuildPlanInput<T>): Promise<WritePlan<T>> {
    if (!changes.length) return []

    const plan: WritePlanEntry<T>[] = []
    const virtual = new Map(handle.state.snapshot() as Map<EntityId, T>)

    for (const change of changes) {
        const id = change.id
        const before = change.before
        const after = change.after
        const action = policy?.action ?? (after === undefined ? 'delete' : 'upsert')
        const meta = ensureWriteItemMeta({
            meta: {
                idempotencyKey: createIdempotencyKey({ now: runtime.now }),
                clientTimeMs: runtime.now()
            },
            now: runtime.now
        })

        const current = virtual.get(id)

        if (action === 'delete') {
            if (after !== undefined) {
                throw new Error(`[Atoma] buildPlan: delete action requires empty target (id=${String(id)})`)
            }
            const previous = current ?? requireChangeBefore({ change, action })
            const baseVersion = requireBaseVersion(id, previous)

            plan.push({
                entry: {
                    entryId: createEntryId(),
                    action: 'delete',
                    item: {
                        id,
                        baseVersion,
                        meta
                    }
                },
                optimistic: {
                    id,
                    before: previous
                }
            })
            virtual.delete(id)
            continue
        }

        if (after === undefined) {
            throw new Error(`[Atoma] buildPlan: ${action} action requires target value (id=${String(id)})`)
        }
        if (after.id !== id) {
            throw new Error(`[Atoma] buildPlan: target id mismatch (change.id=${String(id)} target.id=${String(after.id)})`)
        }

        const outbound = await runtime.transform.outbound(handle, after, context)
        if (outbound === undefined) {
            throw new Error('[Atoma] transform returned empty for outbound write')
        }

        const entryId = createEntryId()

        let entry: WriteEntry
        if (action === 'create') {
            entry = {
                entryId,
                action: 'create',
                item: { id, value: outbound, meta }
            }
        } else if (action === 'update') {
            const baseVersion = requireBaseVersion(id, requireChangeBefore({ change, action }))
            entry = {
                entryId,
                action: 'update',
                item: { id, baseVersion, value: outbound, meta }
            }
        } else {
            const conflict = policy?.action === 'upsert' ? policy.conflict : 'cas'
            const expectedVersion = conflict === 'cas'
                ? resolvePositiveVersion(current ?? before)
                : undefined
            entry = {
                entryId,
                action: 'upsert',
                item: {
                    id,
                    ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
                    value: outbound,
                    meta
                },
                ...(policy?.action === 'upsert' ? { options: { upsert: { conflict: policy.conflict, apply: policy.apply } } } : {})
            }
        }

        plan.push({
            entry,
            optimistic: {
                id,
                before: current,
                after
            }
        })
        virtual.set(id, after)
    }

    return plan
}
