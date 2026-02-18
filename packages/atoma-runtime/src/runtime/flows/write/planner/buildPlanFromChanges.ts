import { createIdempotencyKey, ensureWriteItemMeta, requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
import type { Entity, ActionContext, StoreChange, StoreOperationOptions } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle, WriteEntry, WriteItemMeta, WriteOptions } from 'atoma-types/runtime'
import type { WritePlan, WritePlanEntry, WritePlanPolicy } from '../types'
import { resolveWriteBase } from '../utils/prepareWriteInput'

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

function createPlanEntry<T extends Entity>(args: {
    id: EntityId
    entry: WriteEntry
    value?: T
}): WritePlanEntry<T> {
    return {
        entry: args.entry,
        optimistic: {
            id: args.id,
            ...(args.value !== undefined ? { next: args.value } : {})
        }
    }
}

type WritePlanFromChangesInput<T extends Entity> = {
    runtime: Runtime
    handle: StoreHandle<T>
    context: ActionContext
    options?: StoreOperationOptions
    changes: ReadonlyArray<StoreChange<T>>
    policy?: WritePlanPolicy
    createEntryId: () => string
}

export async function buildPlanFromChanges<T extends Entity>(args: WritePlanFromChangesInput<T>): Promise<WritePlan<T>> {
    if (!args.changes.length) return []

    const plan: WritePlanEntry<T>[] = []
    const virtual = new Map(args.handle.state.getSnapshot() as Map<EntityId, T>)
    const upsertWriteOptions = buildUpsertWriteOptions(args.policy)

    for (const change of args.changes) {
        const id = change.id
        const target = change.after
        const action = args.policy?.action ?? (target === undefined ? 'delete' : 'upsert')
        const meta = createWriteItemMeta(args.runtime.now)
        const current = virtual.get(id) as T | undefined

        if (action === 'delete') {
            if (target !== undefined) {
                throw new Error(`[Atoma] buildPlanFromChanges: delete action requires empty target (id=${String(id)})`)
            }

            const base = current
                ? current
                : await resolveWriteBase(args.runtime, args.handle, id, args.options, args.context)
            const baseVersion = requireBaseVersion(id, base)

            plan.push(createPlanEntry({
                id,
                entry: {
                    entryId: args.createEntryId(),
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

        if (!target) {
            throw new Error(`[Atoma] buildPlanFromChanges: ${action} action requires target value (id=${String(id)})`)
        }
        if (target.id !== id) {
            throw new Error(`[Atoma] buildPlanFromChanges: target id mismatch (change.id=${String(id)} target.id=${String(target.id)})`)
        }

        const outbound = await args.runtime.transform.outbound(args.handle, target, args.context)
        if (outbound === undefined) {
            throw new Error('[Atoma] transform returned empty for outbound write')
        }

        const entryId = args.createEntryId()
        const updateBaseVersion = action === 'update'
            ? requireBaseVersion(
                id,
                current ? current : await resolveWriteBase(args.runtime, args.handle, id, args.options, args.context)
            )
            : undefined
        const upsertBaseVersion = action === 'upsert'
            ? resolvePositiveVersion(current ?? target)
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

        plan.push(createPlanEntry({ id, entry, value: target }))
        virtual.set(id, target)
    }

    return plan
}
