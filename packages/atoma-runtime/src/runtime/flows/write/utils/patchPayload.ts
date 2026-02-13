import type { Entity } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Patch } from 'immer'

export type WritePatchPayload = { patches: Patch[]; inversePatches: Patch[] } | null

export function buildEntityPatchPayload<T extends Entity>(args: {
    enabled: boolean
    id?: EntityId
    before?: T
    after?: T
    remove?: boolean
}): WritePatchPayload {
    if (!args.enabled) return null
    if (!args.id) return null

    const path: Patch['path'] = [args.id as string | number]
    const hasBefore = args.before !== undefined
    const hasAfter = args.after !== undefined

    if (args.remove) {
        const patches: Patch[] = [{ op: 'remove', path }]
        const inversePatches: Patch[] = hasBefore
            ? [{ op: 'add', path, value: args.before }]
            : []
        return { patches, inversePatches }
    }

    if (!hasAfter) {
        return { patches: [], inversePatches: [] }
    }

    if (hasBefore) {
        return {
            patches: [{ op: 'replace', path, value: args.after }],
            inversePatches: [{ op: 'replace', path, value: args.before }]
        }
    }

    return {
        patches: [{ op: 'add', path, value: args.after }],
        inversePatches: [{ op: 'remove', path }]
    }
}

export function buildRawPatchPayload(args: {
    enabled: boolean
    patches: Patch[]
    inversePatches: Patch[]
}): WritePatchPayload {
    if (!args.enabled) return null
    return {
        patches: args.patches,
        inversePatches: args.inversePatches
    }
}
