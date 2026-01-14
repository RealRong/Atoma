import type { Patch } from 'immer'
import type { EntityId } from '#protocol'
import { toEntityId } from './entityId'

export function collectInverseRootAddsByEntityId(inversePatches: unknown): Map<EntityId, unknown> {
    const out = new Map<EntityId, unknown>()
    if (!Array.isArray(inversePatches)) return out

    for (const p of inversePatches as Patch[]) {
        if ((p as any)?.op !== 'add') continue
        const path = (p as any)?.path
        if (!Array.isArray(path) || path.length !== 1) continue
        const id = toEntityId(path[0])
        if (id === null) continue
        out.set(id, (p as any).value)
    }

    return out
}

