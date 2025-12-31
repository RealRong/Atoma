import type { WriteAction, WriteItem, WriteItemMeta } from './types'

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
        kind: 'upsert'
        items: Array<{
            entityId: string
            baseVersion?: number
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

    if (intent.kind === 'upsert') {
        return {
            action: 'upsert',
            items: intent.items.map(i => ({
                entityId: i.entityId,
                ...(typeof i.baseVersion === 'number' ? { baseVersion: i.baseVersion } : {}),
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

    return intent
}
