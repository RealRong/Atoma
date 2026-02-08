import type {
    Entity,
    FilterExpr,
    RelationMap,
    SortRule,
    IndexesLike,
    StoreToken
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { queryLocal } from '../query'
import { getRelationDefaultValue } from './utils/defaultValue'
import { extractKeyValue, pickFirstKey } from './utils/key'
import {
    buildRelationPlan,
    collectRelationStoreTokensFromInclude,
    type IncludeInput,
    type PlannedRelation
} from './planner'

type DynamicEntity = Entity & Record<string, unknown>

export type StoreRuntime = {
    map: Map<EntityId, DynamicEntity>
    indexes?: IndexesLike<DynamicEntity> | null
}

export type GetStoreMap = (store: StoreToken) => Map<EntityId, DynamicEntity> | StoreRuntime | undefined

const DEFAULT_STABLE_SORT: SortRule[] = [{ field: 'id', dir: 'asc' }]

const createEqFilter = (field: string, value: EntityId): FilterExpr => ({
    op: 'eq',
    field,
    value
})

const setRelationValue = <T extends Entity>(item: T, relationName: string, value: unknown) => {
    const target = item as unknown as Record<string, unknown>
    target[relationName] = value
}

const toEntityId = (value: unknown): EntityId | undefined => {
    return typeof value === 'string' ? value : undefined
}

const readField = (item: DynamicEntity, field: string): unknown => {
    return item[field]
}

const resolveLookupMode = (
    indexes: IndexesLike<DynamicEntity> | null,
    targetKeyField: string,
    key: EntityId
): 'index' | 'scan' => {
    if (!indexes) return 'scan'
    const probe = indexes.collectCandidates(createEqFilter(targetKeyField, key))
    return probe.kind === 'unsupported' ? 'scan' : 'index'
}

const dedupeById = <T extends Entity>(items: T[]): T[] => {
    const seen = new Set<EntityId>()
    const output: T[] = []

    for (const item of items) {
        const id = item.id
        if (!id || seen.has(id)) continue
        seen.add(id)
        output.push(item)
    }

    return output
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
            setRelationValue(item, entry.relationName, getRelationDefaultValue(entry.relation))
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
    map: Map<EntityId, DynamicEntity>,
    indexes: IndexesLike<DynamicEntity> | null
) {
    if (entry.targetKeyField === 'id') {
        results.forEach(item => {
            const fk = pickFirstKey(extractKeyValue(item, entry.sourceKeySelector))
            const target = fk !== undefined ? map.get(fk) : undefined
            setRelationValue(item, entry.relationName, target ?? null)
        })
        return
    }

    let lookupMode: 'index' | 'scan' | undefined
    const scannedIndex = new Map<EntityId, DynamicEntity>()
    const pickedByKey = new Map<EntityId, DynamicEntity | null>()

    const getTargetByKey = (key: EntityId): DynamicEntity | undefined => {
        const cached = pickedByKey.get(key)
        if (cached !== undefined) return cached ?? undefined

        if (!lookupMode) {
            lookupMode = resolveLookupMode(indexes, entry.targetKeyField, key)
        }

        if (lookupMode === 'index' && indexes) {
            const res = indexes.collectCandidates(createEqFilter(entry.targetKeyField, key))
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
                const targetKey = toEntityId(readField(target, entry.targetKeyField))
                if (!targetKey) return
                if (!scannedIndex.has(targetKey)) scannedIndex.set(targetKey, target)
            })
        }

        const target = scannedIndex.get(key)
        pickedByKey.set(key, target ?? null)
        return target
    }

    results.forEach(item => {
        const fk = pickFirstKey(extractKeyValue(item, entry.sourceKeySelector))
        const target = fk !== undefined ? getTargetByKey(fk) : undefined
        setRelationValue(item, entry.relationName, target ?? null)
    })
}

function projectHasManyOrHasOne<TSource extends Entity>(
    results: TSource[],
    entry: PlannedRelation<TSource>,
    map: Map<EntityId, DynamicEntity>,
    indexes: IndexesLike<DynamicEntity> | null
) {
    const isHasOne = entry.relationType === 'hasOne'

    let bucket: Map<EntityId, DynamicEntity[]> | null = null
    let keyLookupMode: 'index' | 'scan' | undefined
    const perKeyCache = new Map<EntityId, DynamicEntity[]>()

    const getTargetsByKey = (key: EntityId): DynamicEntity[] => {
        const cached = perKeyCache.get(key)
        if (cached) return cached

        if (!keyLookupMode) {
            keyLookupMode = resolveLookupMode(indexes, entry.targetKeyField, key)
        }

        if (keyLookupMode === 'index' && indexes) {
            const res = indexes.collectCandidates(createEqFilter(entry.targetKeyField, key))
            if (res.kind !== 'candidates') {
                perKeyCache.set(key, [])
                return []
            }

            const output: DynamicEntity[] = []
            for (const id of res.ids) {
                const target = map.get(id)
                if (target) output.push(target)
            }
            perKeyCache.set(key, output)
            return output
        }

        if (keyLookupMode !== 'scan') keyLookupMode = 'scan'
        if (!bucket) {
            const next = new Map<EntityId, DynamicEntity[]>()
            map.forEach(target => {
                const targetKey = toEntityId(readField(target, entry.targetKeyField))
                if (!targetKey) return
                const list = next.get(targetKey) || []
                list.push(target)
                next.set(targetKey, list)
            })
            bucket = next
        }

        const output = bucket.get(key) || []
        perKeyCache.set(key, output)
        return output
    }

    results.forEach(item => {
        const keyValue = extractKeyValue(item, entry.sourceKeySelector)
        if (keyValue === undefined || keyValue === null) {
            setRelationValue(item, entry.relationName, getRelationDefaultValue(entry.relation))
            return
        }

        const keys = Array.isArray(keyValue) ? keyValue : [keyValue]
        const merged: DynamicEntity[] = []
        keys.forEach(key => {
            if (key === undefined || key === null) return
            const list = getTargetsByKey(key)
            if (list.length) merged.push(...list)
        })

        const deduped = dedupeById(merged)
        if (deduped.length === 0) {
            setRelationValue(item, entry.relationName, isHasOne ? null : [])
            return
        }

        const limit = isHasOne ? 1 : entry.projectionOptions.limit
        const sortRules = entry.projectionOptions.sort?.length
            ? entry.projectionOptions.sort
            : DEFAULT_STABLE_SORT

        const projected = queryLocal(deduped, {
            sort: sortRules,
            page: {
                mode: 'offset',
                limit
            }
        }).data

        setRelationValue(item, entry.relationName, isHasOne
            ? (projected[0] ?? null)
            : projected)
    })
}
