import type {
    Entity,
    Query,
    KeySelector,
    RelationConfig,
    RelationMap,
    StoreIndexesLike,
    StoreToken
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { executeLocalQuery } from '../query'
import { getValueByPath } from './utils'
import {
    buildRelationPlan,
    collectRelationStoreTokensFromInclude,
    type IncludeInput,
    type PlannedRelation
} from './planner'

export type StoreRuntime = {
    map: Map<EntityId, any>
    indexes?: StoreIndexesLike<any> | null
}

export type GetStoreMap = (store: StoreToken) => Map<EntityId, any> | StoreRuntime | undefined

const getDefaultValue = (config: RelationConfig<any, any> | undefined) => {
    if (!config) return null
    if (config.type === 'hasMany') return []
    return null
}

const extractKeyValue = <T>(item: T, selector: KeySelector<T>): EntityId | EntityId[] | undefined | null => {
    if (typeof selector === 'function') return selector(item)
    return getValueByPath(item, selector)
}

const pickFirstKey = (value: EntityId | EntityId[] | undefined | null): EntityId | undefined => {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) return value
    for (const v of value) {
        if (v !== undefined && v !== null) return v
    }
    return undefined
}

export function collectRelationStoreTokens<T extends Entity>(
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): StoreToken[] {
    return collectRelationStoreTokensFromInclude(include, relations)
}

export function projectRelationsBatch<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined,
    getStoreMap: GetStoreMap
): T[] {
    if (!items.length || !include || !relations) return items

    const results = items.map(item => ({ ...item })) as T[]
    const plan = buildRelationPlan(results, include, relations)

    plan.forEach(entry => {
        projectPlanned(results, entry, getStoreMap)
    })

    return results
}

function projectPlanned<TSource extends Entity>(
    results: TSource[],
    entry: PlannedRelation<TSource>,
    getStoreMap: GetStoreMap
) {
    const runtime = getStoreMap(entry.store)
    const map = runtime instanceof Map
        ? runtime
        : runtime?.map
    const indexes = runtime instanceof Map
        ? null
        : runtime?.indexes ?? null

    if (!map) {
        results.forEach(item => {
            ;(item as any)[entry.relationName] = getDefaultValue(entry.relation)
        })
        return
    }

    if (entry.relationType === 'belongsTo') {
        projectBelongsTo(results, entry, map, indexes)
        return
    }

    projectHasManyOrHasOne(results, entry, map, indexes)
}

function projectBelongsTo<TSource extends Entity>(
    results: TSource[],
    entry: PlannedRelation<TSource>,
    map: Map<EntityId, any>,
    indexes: StoreIndexesLike<any> | null
) {
    if (entry.targetKeyField === 'id') {
        results.forEach(item => {
            const fk = pickFirstKey(extractKeyValue(item, entry.sourceKeySelector))
            const target = fk !== undefined ? map.get(fk) : undefined
            ;(item as any)[entry.relationName] = target ?? null
        })
        return
    }

    let lookupMode: 'index' | 'scan' | undefined
    const scannedIndex = new Map<EntityId, any>()
    const pickedByKey = new Map<EntityId, any>()

    const getTargetByKey = (key: EntityId): any | undefined => {
        const cached = pickedByKey.get(key)
        if (cached !== undefined) return cached

        if (!lookupMode && indexes) {
            const probe = indexes.collectCandidates({ [entry.targetKeyField]: { eq: key } } as any)
            lookupMode = probe.kind === 'unsupported' ? 'scan' : 'index'
        }

        if (lookupMode === 'index' && indexes) {
            const res = indexes.collectCandidates({ [entry.targetKeyField]: { eq: key } } as any)
            if (res.kind !== 'candidates') {
                pickedByKey.set(key, null)
                return undefined
            }
            for (const id of res.ids) {
                const target = map.get(id)
                if (target) {
                    pickedByKey.set(key, target)
                    return target
                }
            }
            pickedByKey.set(key, null)
            return undefined
        }

        if (lookupMode !== 'scan') lookupMode = 'scan'
        if (scannedIndex.size === 0) {
            map.forEach(target => {
                const k = (target as any)?.[entry.targetKeyField] as EntityId | undefined | null
                if (k === undefined || k === null) return
                if (!scannedIndex.has(k)) scannedIndex.set(k, target)
            })
        }
        const target = scannedIndex.get(key)
        pickedByKey.set(key, target ?? null)
        return target
    }

    results.forEach(item => {
        const fk = pickFirstKey(extractKeyValue(item, entry.sourceKeySelector))
        const target = fk !== undefined ? getTargetByKey(fk) : undefined
        ;(item as any)[entry.relationName] = target ?? null
    })
}

function projectHasManyOrHasOne<TSource extends Entity>(
    results: TSource[],
    entry: PlannedRelation<TSource>,
    map: Map<EntityId, any>,
    indexes: StoreIndexesLike<any> | null
) {
    const isHasOne = entry.relationType === 'hasOne'

    let bucket: Map<EntityId, any[]> | null = null
    let keyLookupMode: 'index' | 'scan' | undefined
    const perKeyCache = new Map<EntityId, any[]>()

    const getTargetsByKey = (key: EntityId): any[] => {
        const cached = perKeyCache.get(key)
        if (cached) return cached

        if (!keyLookupMode && indexes) {
            const probe = indexes.collectCandidates({ [entry.targetKeyField]: { eq: key } } as any)
            keyLookupMode = probe.kind === 'unsupported' ? 'scan' : 'index'
        }

        if (keyLookupMode === 'index' && indexes) {
            const res = indexes.collectCandidates({ [entry.targetKeyField]: { eq: key } } as any)
            if (res.kind !== 'candidates') {
                perKeyCache.set(key, [])
                return []
            }
            const out: any[] = []
            for (const id of res.ids) {
                const target = map.get(id)
                if (target) out.push(target)
            }
            perKeyCache.set(key, out)
            return out
        }

        if (keyLookupMode !== 'scan') keyLookupMode = 'scan'
        if (!bucket) {
            const next = new Map<EntityId, any[]>()
            map.forEach(target => {
                const k = (target as any)?.[entry.targetKeyField] as EntityId | undefined | null
                if (k === undefined || k === null) return
                const arr = next.get(k) || []
                arr.push(target)
                next.set(k, arr)
            })
            bucket = next
        }
        const out = bucket.get(key) || []
        perKeyCache.set(key, out)
        return out
    }

    results.forEach(item => {
        const keyValue = extractKeyValue(item, entry.sourceKeySelector)
        if (keyValue === undefined || keyValue === null) {
            ;(item as any)[entry.relationName] = getDefaultValue(entry.relation)
            return
        }

        const keys = Array.isArray(keyValue) ? keyValue : [keyValue]
        const matches: any[] = []
        keys.forEach(k => {
            if (k === undefined || k === null) return
            const arr = getTargetsByKey(k)
            if (arr.length) matches.push(...arr)
        })

        const sort = entry.projectionOptions.sort
        if (isHasOne && !sort) {
            ;(item as any)[entry.relationName] = matches[0] ?? null
            return
        }

        const limit = isHasOne ? 1 : entry.projectionOptions.limit
        if (!sort) {
            ;(item as any)[entry.relationName] = isHasOne
                ? (matches[0] ?? null)
                : (limit === undefined ? matches : matches.slice(0, limit))
            return
        }

        const projected = executeLocalQuery(matches as any, {
            sort: sort as any,
            page: { mode: 'offset', limit }
        } as any).data

        ;(item as any)[entry.relationName] = isHasOne
            ? (projected[0] ?? null)
            : projected
    })
}
