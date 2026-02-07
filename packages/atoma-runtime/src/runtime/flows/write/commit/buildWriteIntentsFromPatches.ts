import type { Entity, WriteIntent } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { entityId as entityIdUtils, immer as immerUtils, version } from 'atoma-shared'
import { applyPatches, type Patch } from 'immer'

export function buildWriteIntentsFromPatches<T extends Entity>(args: {
    baseState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
}): WriteIntent<T>[] {
    const optimisticState = applyPatches(args.baseState, args.patches) as Map<EntityId, T>
    const touchedIds = new Set<EntityId>()
    args.patches.forEach(p => {
        const root = p.path?.[0]
        if (entityIdUtils.isEntityId(root)) touchedIds.add(root as EntityId)
    })

    const inverseRootAdds = immerUtils.collectInverseRootAddsByEntityId(args.inversePatches)
    const baseVersionByDeletedId = new Map<EntityId, number>()
    inverseRootAdds.forEach((value, id) => {
        baseVersionByDeletedId.set(id, version.requireBaseVersion(id, value))
    })

    const intents: WriteIntent<T>[] = []
    for (const id of touchedIds.values()) {
        const next = optimisticState.get(id)
        if (next) {
            const baseVersion = version.resolvePositiveVersion(next)
            intents.push({
                action: 'upsert',
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: next,
                options: { merge: false, upsert: { mode: 'loose' } }
            })
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }
        intents.push({ action: 'delete', entityId: id, baseVersion })
    }

    return intents
}
