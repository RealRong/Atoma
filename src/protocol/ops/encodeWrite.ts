import type { Patch } from 'immer'
import type { WriteAction, WriteItem, WriteItemMeta } from './types'
import { convertImmerPatchesToJsonPatches } from '../jsonPatch/immer'

export type WriteIntent =
    | {
        kind: 'create'
        items: Array<{
            entityId?: string
            value: unknown
            meta?: WriteItemMeta
        }>
    }
    | {
        kind: 'update'
        items: Array<{
            entityId: string
            value: unknown
            baseVersion?: number
            meta?: WriteItemMeta
        }>
    }
    | {
        kind: 'delete'
        items: Array<{
            entityId: string
            baseVersion?: number
            meta?: WriteItemMeta
        }>
    }
    | {
        kind: 'patch'
        items: Array<{
            entityId: string
            baseVersion: number
            patches: Patch[]
            /** Immer patch path 的顶层实体 ID（用于把 '/<id>/field' 变成 '/field'） */
            rootEntityId: string | number
            meta?: WriteItemMeta
        }>
    }

export function encodeWriteIntent(intent: WriteIntent): { action: WriteAction; items: WriteItem[] } {
    if (intent.kind === 'create') {
        return {
            action: 'create',
            items: intent.items.map(i => ({
                ...(typeof i.entityId === 'string' && i.entityId ? { entityId: i.entityId } : {}),
                value: i.value,
                ...(i.meta ? { meta: i.meta } : {})
            }))
        }
    }

    if (intent.kind === 'update') {
        return {
            action: 'update',
            items: intent.items.map(i => ({
                entityId: i.entityId,
                value: i.value,
                ...(typeof i.baseVersion === 'number' ? { baseVersion: i.baseVersion } : {}),
                ...(i.meta ? { meta: i.meta } : {})
            }))
        }
    }

    if (intent.kind === 'delete') {
        return {
            action: 'delete',
            items: intent.items.map(i => ({
                entityId: i.entityId,
                ...(typeof i.baseVersion === 'number' ? { baseVersion: i.baseVersion } : {}),
                ...(i.meta ? { meta: i.meta } : {})
            }))
        }
    }

    if (intent.kind === 'patch') {
        return {
            action: 'patch',
            items: intent.items.map(i => ({
                entityId: i.entityId,
                baseVersion: i.baseVersion,
                patch: convertImmerPatchesToJsonPatches(i.patches, i.rootEntityId),
                ...(i.meta ? { meta: i.meta } : {})
            }))
        }
    }

    const _exhaustive: never = intent
    return _exhaustive
}
