import { applyPatches, type Patch } from 'immer'
import { createIdempotencyKey, ensureWriteItemMeta, requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
import type { Entity, OperationContext } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'
import type { WritePlan, WritePlanEntry } from '../types'

function collectInverseRootAdds(inversePatches: Patch[]): Map<EntityId, unknown> {
    const out = new Map<EntityId, unknown>()
    if (!Array.isArray(inversePatches)) return out

    for (const patch of inversePatches) {
        if ((patch as any)?.op !== 'add') continue
        const path = (patch as any)?.path
        if (!Array.isArray(path) || path.length !== 1) continue

        const root = path[0]
        if (typeof root !== 'string' && typeof root !== 'number') continue
        out.set(String(root), (patch as any).value)
    }

    return out
}

export async function buildPatchWritePlan<T extends Entity>(args: {
    runtime: Runtime
    handle: StoreHandle<T>
    opContext: OperationContext
    baseState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
    createEntryId: () => string
}): Promise<WritePlan<T>> {
    const optimisticState = applyPatches(args.baseState, args.patches) as Map<EntityId, T>
    const touchedIds = new Set<EntityId>()

    for (const patch of args.patches) {
        const root = patch.path?.[0]
        if (typeof root === 'string' || typeof root === 'number') {
            const id = String(root)
            if (id.length > 0) {
                touchedIds.add(id)
            }
        }
    }

    const inverseRootAdds = collectInverseRootAdds(args.inversePatches)
    const baseVersionByDeletedId = new Map<EntityId, number>()
    inverseRootAdds.forEach((value, id) => {
        baseVersionByDeletedId.set(id, requireBaseVersion(id, value))
    })

    const plan: WritePlanEntry<T>[] = []
    for (const id of touchedIds.values()) {
        const writeItemMeta = ensureWriteItemMeta({
            meta: {
                idempotencyKey: createIdempotencyKey({ now: args.runtime.now }),
                clientTimeMs: args.runtime.now()
            },
            now: args.runtime.now
        })

        const next = optimisticState.get(id)
        if (next) {
            const baseVersion = resolvePositiveVersion(next)
            const outbound = await args.runtime.transform.outbound(args.handle, next, args.opContext)
            if (outbound === undefined) {
                throw new Error('[Atoma] transform returned empty for outbound write')
            }

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
                    value: next
                }
            })
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }

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
    }

    return plan
}
