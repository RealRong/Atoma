import type { EntityId } from '#protocol'

export function isEntityId(value: unknown): value is EntityId {
    return typeof value === 'string' && value.length > 0
}

export function toEntityId(value: unknown): EntityId | null {
    return isEntityId(value) ? value : null
}

