import { createIdempotencyKey, ensureWriteItemMeta, requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
import type { ChangeDirection, Entity, OperationContext, StoreChange, StoreOperationOptions } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'
import type { WritePlan, WritePlanEntry } from '../types'
import { resolveWriteBase } from './prepareWriteInput'

function resolveTarget<T extends Entity>(change: StoreChange<T>, direction: ChangeDirection): T | undefined {
    return direction === 'forward'
        ? change.after
        : change.before
}

export async function buildChangeWritePlan<T extends Entity>(args: {
    runtime: Runtime
    handle: StoreHandle<T>
    opContext: OperationContext
    changes: ReadonlyArray<StoreChange<T>>
    direction: ChangeDirection
    options?: StoreOperationOptions
    createEntryId: () => string
}): Promise<WritePlan<T>> {
    if (!args.changes.length) return []

    const virtual = new Map(args.handle.state.getSnapshot() as Map<EntityId, T>)
    const plan: WritePlanEntry<T>[] = []

    for (const change of args.changes) {
        const id = change.id
        const current = virtual.get(id) as T | undefined
        const target = resolveTarget(change, args.direction)
        const writeItemMeta = ensureWriteItemMeta({
            meta: {
                idempotencyKey: createIdempotencyKey({ now: args.runtime.now }),
                clientTimeMs: args.runtime.now()
            },
            now: args.runtime.now
        })

        if (!target) {
            const base = current
                ? current
                : await resolveWriteBase(args.runtime, args.handle, id, args.options)
            const baseVersion = requireBaseVersion(id, base)
            plan.push({
                entry: {
                    entryId: args.createEntryId(),
                    action: 'delete',
                    item: {
                        entityId: id,
                        baseVersion,
                        meta: writeItemMeta
                    }
                },
                optimistic: {
                    entityId: id
                }
            })
            virtual.delete(id)
            continue
        }

        if (target.id !== id) {
            throw new Error(`[Atoma] applyChanges: target id mismatch (change.id=${String(id)} target.id=${String(target.id)})`)
        }

        const outbound = await args.runtime.transform.outbound(args.handle, target, args.opContext)
        if (outbound === undefined) {
            throw new Error('[Atoma] transform returned empty for outbound write')
        }
        const baseVersion = resolvePositiveVersion(current ?? target)

        plan.push({
            entry: {
                entryId: args.createEntryId(),
                action: 'upsert',
                item: {
                    entityId: id,
                    ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                    value: outbound,
                    meta: writeItemMeta
                },
                options: { merge: false, upsert: { mode: 'loose' } }
            },
            optimistic: {
                entityId: id,
                value: target
            }
        })
        virtual.set(id, target)
    }

    return plan
}
