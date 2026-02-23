import type { Entity, KeySelector } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { getValueByPath } from './path'

export function extractKeyValue<T>(item: T, selector: KeySelector<T>): EntityId | EntityId[] | undefined {
    if (typeof selector === 'function') {
        const value = selector(item)
        if (typeof value === 'string') return value
        if (!Array.isArray(value)) return undefined

        const ids = value.filter((entry): entry is EntityId => typeof entry === 'string')
        return ids.length ? ids : undefined
    }

    if (typeof selector !== 'string') return undefined

    const value = getValueByPath(item, selector)
    if (typeof value === 'string') return value
    if (!Array.isArray(value)) return undefined

    const ids = value.filter((entry): entry is EntityId => typeof entry === 'string')
    return ids.length ? ids : undefined
}

export function pickFirstKey(value: EntityId | EntityId[] | undefined): EntityId | undefined {
    if (value === undefined) return undefined
    return Array.isArray(value) ? value[0] : value
}

export function collectUniqueKeys<T extends Entity>(items: T[], selector: KeySelector<T>): EntityId[] {
    const output = new Set<EntityId>()

    for (const item of items) {
        const keyValue = extractKeyValue(item, selector)
        if (keyValue === undefined) continue

        if (Array.isArray(keyValue)) {
            for (const key of keyValue) {
                output.add(key)
            }
            continue
        }

        output.add(keyValue)
    }

    return Array.from(output)
}
