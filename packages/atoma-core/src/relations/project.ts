import type {
    Entity,
    FilterExpr,
    IndexQueryLike,
    RelationMap,
    SortRule,
    StoreToken
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { runQuery } from '../query'
import { extractKeyValue, pickFirstKey } from './key'
import { buildRelationPlan, type IncludeInput, type PlannedRelation } from './plan'

export type RelationStoreState = {
    map: ReadonlyMap<EntityId, Entity>
    indexes: IndexQueryLike<Entity> | null
}

export type RelationStoreStates = ReadonlyMap<StoreToken, RelationStoreState>

const DEFAULT_STABLE_SORT: SortRule[] = [{ field: 'id', dir: 'asc' }]

const createEqFilter = (field: string, value: EntityId): FilterExpr => ({
    op: 'eq',
    field,
    value
})

const getDefaultRelationValue = (relationType: PlannedRelation<Entity>['relationType']): null | [] => {
    return relationType === 'hasMany' ? [] : null
}

const setRelationValue = <T extends Entity>(item: T, relationName: string, value: unknown) => {
    const target = item as unknown as Record<string, unknown>
    target[relationName] = value
}

const toEntityId = (value: unknown): EntityId | undefined => {
    return typeof value === 'string' ? value : undefined
}

const readField = (item: Entity, field: string): unknown => {
    return (item as unknown as Record<string, unknown>)[field]
}

const resolveLookupMode = (
    indexes: IndexQueryLike<Entity> | null,
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

export function projectRelationsBatch<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined,
    storeStates: RelationStoreStates
): T[] {
    if (!items.length || !include || !relations) return items

    const results = items.map(item => ({ ...item })) as T[]
    const plan = buildRelationPlan(results, include, relations)

    plan.forEach(entry => {
        projectPlanned(results, entry, storeStates)
    })

    return results
}

function projectPlanned<TSource extends Entity>(
    results: TSource[],
    entry: PlannedRelation<TSource>,
    storeStates: RelationStoreStates
) {
    const runtime = storeStates.get(entry.store)
    const map = runtime?.map
    const indexes = runtime?.indexes ?? null

    if (!map) {
        results.forEach(item => {
            setRelationValue(item, entry.relationName, getDefaultRelationValue(entry.relationType))
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
    map: ReadonlyMap<EntityId, Entity>,
    indexes: IndexQueryLike<Entity> | null
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
    const scannedIndex = new Map<EntityId, Entity>()
    const pickedByKey = new Map<EntityId, Entity | null>()

    const getTargetByKey = (key: EntityId): Entity | undefined => {
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
    map: ReadonlyMap<EntityId, Entity>,
    indexes: IndexQueryLike<Entity> | null
) {
    const isHasOne = entry.relationType === 'hasOne'

    let bucket: Map<EntityId, Entity[]> | null = null
    let keyLookupMode: 'index' | 'scan' | undefined
    const perKeyCache = new Map<EntityId, Entity[]>()

    const getTargetsByKey = (key: EntityId): Entity[] => {
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

            const output: Entity[] = []
            for (const id of res.ids) {
                const target = map.get(id)
                if (target) output.push(target)
            }
            perKeyCache.set(key, output)
            return output
        }

        if (keyLookupMode !== 'scan') keyLookupMode = 'scan'
        if (!bucket) {
            const next = new Map<EntityId, Entity[]>()
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
            setRelationValue(item, entry.relationName, isHasOne ? null : [])
            return
        }

        const keys = Array.isArray(keyValue) ? keyValue : [keyValue]
        const merged: Entity[] = []
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

        const projected = runQuery({
            snapshot: new Map(deduped.map(item => [item.id, item] as const)),
            query: {
                sort: sortRules,
                page: {
                    mode: 'offset',
                    limit
                }
            },
            indexes: null
        }).data

        setRelationValue(item, entry.relationName, isHasOne
            ? (projected[0] ?? null)
            : projected)
    })
}
