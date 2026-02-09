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
export type RelationConfigLike = {
    type?: unknown
}

type IncludeOptions = {
    live?: boolean
    prefetch?: PrefetchMode
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const warnInvalidIncludeOption = (name: string, key: string, expected: string, received: unknown) => {
    console.warn(`[Atoma] include.${name}.${key} 应为 ${expected}，已忽略非法值:`, received)
}

const normalizeIncludeOptions = (name: string, value: unknown): IncludeOptions => {
    if (!isRecord(value)) return {}

    const options: IncludeOptions = {}

    if ('live' in value) {
        if (typeof value.live === 'boolean') {
            options.live = value.live
        } else if (value.live !== undefined) {
            warnInvalidIncludeOption(name, 'live', 'boolean', value.live)
        }
    }

    if ('prefetch' in value) {
        const mode = value.prefetch
        if (mode === 'on-mount' || mode === 'on-change' || mode === 'manual') {
            options.prefetch = mode
        } else if (mode !== undefined) {
            warnInvalidIncludeOption(name, 'prefetch', "'on-mount' | 'on-change' | 'manual'", mode)
        }
    }

    return options
}

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
        const normalized = normalizeIncludeOptions(name, opts)
        const isLive = normalized.live !== false
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

export function resolvePrefetchMode(relConfig: RelationConfigLike, includeValue: unknown): PrefetchMode {
    if (isRecord(includeValue)) {
        const mode = normalizeIncludeOptions('_', includeValue).prefetch
        if (mode) return mode
    }
    return relConfig?.type === 'hasMany' ? 'on-mount' : 'on-change'
}

export function buildPrefetchDoneKey(args: { includeKey: string; relationName: string }): string {
    return `${args.includeKey}:${args.relationName}`
}

export function filterStableItemsForRelation<T extends Entity>(args: {
    items: T[]
    relationConfig: RelationConfigLike
    mode: PrefetchMode
    newIds: Set<EntityId>
    force?: boolean
}): T[] {
    const { items, relationConfig, mode, newIds, force } = args
    if (force || relationConfig?.type !== 'hasMany') {
        return items
    }

    if (mode === 'on-mount') {
        return items
    }

    if (newIds.size === 0) return []

    return items.filter(item => {
        const id = getEntityId(item)
        return Boolean(id && newIds.has(id))
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

export function normalizeStoreName(store: unknown, fallback: StoreToken): string {
    if (!isRecord(store)) return String(fallback ?? '')
    const name = store.name
    return String(name ?? fallback ?? '')
}
