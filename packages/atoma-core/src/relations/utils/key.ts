import type { Entity, KeySelector } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { getValueByPath } from './path'

const isEntityId = (value: unknown): value is EntityId => {
    return typeof value === 'string'
}

const normalizeEntityIdArray = (value: unknown): EntityId[] | undefined => {
    if (!Array.isArray(value)) return undefined

    const output: EntityId[] = []
    value.forEach(entry => {
        if (isEntityId(entry)) output.push(entry)
    })

    return output.length ? output : undefined
}

export function extractKeyValue<T>(item: T, selector: KeySelector<T>): EntityId | EntityId[] | undefined | null {
    if (typeof selector === 'function') return selector(item)
    if (typeof selector !== 'string') return undefined

    const value = getValueByPath(item, selector)
    if (value === null) return null
    if (isEntityId(value)) return value

    return normalizeEntityIdArray(value)
}

export function pickFirstKey(value: EntityId | EntityId[] | undefined | null): EntityId | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) return value

    for (const entry of value) {
        if (entry !== undefined && entry !== null) return entry
    }

    return undefined
}

export function collectUniqueKeys<T extends Entity>(items: T[], selector: KeySelector<T>): EntityId[] {
    const output = new Set<EntityId>()

    items.forEach(item => {
        const keyValue = extractKeyValue(item, selector)
        if (keyValue === undefined || keyValue === null) return

        if (Array.isArray(keyValue)) {
            keyValue.forEach(key => {
                if (key === undefined || key === null) return
                output.add(key)
            })
            return
        }

        output.add(keyValue)
    })

    return Array.from(output)
}
