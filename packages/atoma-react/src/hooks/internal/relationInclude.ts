import { stableStringify } from 'atoma-shared'
import type { Entity, StoreToken } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'

export type IncludeBucket = Readonly<{
    includeKey: string
    effectiveInclude: Record<string, any> | undefined
    liveInclude: Record<string, any> | undefined
    snapshotInclude: Record<string, any> | undefined
    snapshotNames: string[]
}>

export type PrefetchMode = 'on-mount' | 'on-change' | 'manual'

export function getEntityId(item: any): EntityId | undefined {
    const id = item?.id
    return (typeof id === 'string' && id) ? (id as EntityId) : undefined
}

export function normalizeInclude(include?: Record<string, any>): IncludeBucket {
    const effectiveInclude = include && Object.keys(include).length ? include : undefined
    const includeKey = stableStringify(effectiveInclude)

    if (!effectiveInclude) {
        return {
            includeKey,
            effectiveInclude,
            liveInclude: undefined,
            snapshotInclude: undefined,
            snapshotNames: []
        }
    }

    const live: Record<string, any> = {}
    const snapshot: Record<string, any> = {}

    Object.entries(effectiveInclude).forEach(([name, opts]) => {
        if (opts === false || opts === undefined || opts === null) return
        const isLive = typeof opts === 'object' ? (opts as any).live !== false : true
        ;(isLive ? live : snapshot)[name] = opts
    })

    const snapshotNames = Object.keys(snapshot)
    return {
        includeKey,
        effectiveInclude,
        liveInclude: Object.keys(live).length ? live : undefined,
        snapshotInclude: snapshotNames.length ? snapshot : undefined,
        snapshotNames
    }
}

export function resolvePrefetchMode(relConfig: any, includeValue: any): PrefetchMode {
    if (includeValue && typeof includeValue === 'object') {
        const mode = includeValue.prefetch
        if (mode === 'on-mount' || mode === 'on-change' || mode === 'manual') return mode
    }
    return relConfig?.type === 'hasMany' ? 'on-mount' : 'on-change'
}

export function buildPrefetchDoneKey(args: { includeKey: string; relationName: string }): string {
    return `${args.includeKey}:${args.relationName}`
}

export function filterStableItemsForRelation<T extends Entity>(args: {
    items: T[]
    relationConfig: any
    newIds: Set<EntityId>
    force?: boolean
}): T[] {
    const { items, relationConfig, newIds, force } = args
    if (force || relationConfig?.type !== 'hasMany' || newIds.size === 0) {
        return items
    }

    return items.filter(item => {
        const id = getEntityId(item)
        return Boolean(id && !newIds.has(id))
    })
}

export function collectCurrentAndNewIds<T extends Entity>(
    items: T[],
    previousIds: Set<EntityId>
): { currentIds: Set<EntityId>; newIds: Set<EntityId> } {
    const currentIds = new Set<EntityId>()
    items.forEach(item => {
        const id = getEntityId(item)
        if (id) currentIds.add(id)
    })

    const newIds = new Set<EntityId>()
    currentIds.forEach(id => {
        if (!previousIds.has(id)) newIds.add(id)
    })

    return { currentIds, newIds }
}

export function normalizeStoreName(store: any, fallback: StoreToken): string {
    return String(store?.name ?? fallback ?? '')
}

