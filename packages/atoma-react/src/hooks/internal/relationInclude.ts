import { stableStringify } from 'atoma-shared'
import { pickIncludeOptions } from 'atoma-core/relations'
import type {
    Entity,
    RelationConfig,
    RelationIncludeInput,
    RelationPrefetchMode,
    StoreToken
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'

type RelationInclude = RelationIncludeInput<Record<string, unknown>>

export type IncludeBucket = Readonly<{
    includeKey: string
    effectiveInclude: RelationInclude | undefined
    liveInclude: RelationInclude | undefined
    snapshotInclude: RelationInclude | undefined
    snapshotNames: string[]
}>

export type PrefetchMode = RelationPrefetchMode

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const warnInvalidIncludeOption = (name: string, key: string, expected: string, received: unknown) => {
    console.warn(`[Atoma] include.${name}.${key} 应为 ${expected}，已忽略非法值:`, received)
}

export function getEntityId(item: unknown): EntityId | undefined {
    const id = isRecord(item) ? item.id : undefined
    return (typeof id === 'string' && id) ? (id as EntityId) : undefined
}

export function normalizeInclude(include?: RelationInclude): IncludeBucket {
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

    const live: Record<string, unknown> = {}
    const snapshot: Record<string, unknown> = {}

    Object.entries(effectiveInclude).forEach(([name, opts]) => {
        if (opts === false || opts === undefined || opts === null) return
        if (isRecord(opts) && 'live' in opts && opts.live !== undefined && typeof opts.live !== 'boolean') {
            warnInvalidIncludeOption(name, 'live', 'boolean', opts.live)
        }
        const normalized = pickIncludeOptions(opts)
        const isLive = normalized.live !== false
        ;(isLive ? live : snapshot)[name] = opts
    })

    const snapshotNames = Object.keys(snapshot)
    return {
        includeKey,
        effectiveInclude,
        liveInclude: Object.keys(live).length ? live as RelationInclude : undefined,
        snapshotInclude: snapshotNames.length ? snapshot as RelationInclude : undefined,
        snapshotNames
    }
}

export function resolvePrefetchMode<TSource extends Entity>(
    relConfig: RelationConfig<TSource, Entity>,
    includeValue: unknown,
    relationName = '_'
): PrefetchMode {
    if (isRecord(includeValue) && 'prefetch' in includeValue && includeValue.prefetch !== undefined) {
        const normalized = pickIncludeOptions(includeValue).prefetch
        if (normalized) return normalized
        warnInvalidIncludeOption(relationName, 'prefetch', "'on-mount' | 'on-change' | 'manual'", includeValue.prefetch)
    }
    return relConfig?.type === 'hasMany' ? 'on-mount' : 'on-change'
}

export function buildPrefetchDoneKey(args: { includeKey: string; relationName: string }): string {
    return `${args.includeKey}:${args.relationName}`
}

export function filterStableItemsForRelation<T extends Entity, TSource extends Entity = T>(args: {
    items: T[]
    relationConfig: RelationConfig<TSource, Entity>
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
