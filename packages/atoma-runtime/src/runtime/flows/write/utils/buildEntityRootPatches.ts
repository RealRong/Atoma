import type { EntityId } from 'atoma-types/protocol'
import type { Patch } from 'immer'

export function buildEntityRootPatches<T>(args: {
    id: EntityId
    before?: T
    after?: T
    remove?: boolean
}): { patches: Patch[]; inversePatches: Patch[] } {
    const { id, before, after, remove } = args
    const hasBefore = before !== undefined
    const hasAfter = after !== undefined

    if (remove) {
        const patches: Patch[] = [{ op: 'remove', path: [id] as any }]
        const inversePatches: Patch[] = hasBefore
            ? [{ op: 'add', path: [id] as any, value: before } as any]
            : []
        return { patches, inversePatches }
    }

    if (!hasAfter) {
        return { patches: [], inversePatches: [] }
    }

    if (hasBefore) {
        return {
            patches: [{ op: 'replace', path: [id] as any, value: after } as any],
            inversePatches: [{ op: 'replace', path: [id] as any, value: before } as any]
        }
    }

    return {
        patches: [{ op: 'add', path: [id] as any, value: after } as any],
        inversePatches: [{ op: 'remove', path: [id] as any }]
    }
}
