import type { EntityId } from 'atoma-types/protocol'
import type { Patch } from 'immer'

const toRootPath = (id: EntityId): Patch['path'] => [id as string | number]

export function buildEntityRootPatches<T>(args: {
    id: EntityId
    before?: T
    after?: T
    remove?: boolean
}): { patches: Patch[]; inversePatches: Patch[] } {
    const { id, before, after, remove } = args
    const path = toRootPath(id)
    const hasBefore = before !== undefined
    const hasAfter = after !== undefined

    if (remove) {
        const patches: Patch[] = [{ op: 'remove', path }]
        const inversePatches: Patch[] = hasBefore
            ? [{ op: 'add', path, value: before }]
            : []
        return { patches, inversePatches }
    }

    if (!hasAfter) {
        return { patches: [], inversePatches: [] }
    }

    if (hasBefore) {
        return {
            patches: [{ op: 'replace', path, value: after }],
            inversePatches: [{ op: 'replace', path, value: before }]
        }
    }

    return {
        patches: [{ op: 'add', path, value: after }],
        inversePatches: [{ op: 'remove', path }]
    }
}
