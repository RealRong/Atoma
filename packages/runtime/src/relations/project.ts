import type {
    Entity,
    FilterExpr,
    Indexes,
    KeySelector,
    RelationQuery,
    RelationMap,
    SortRule,
    StoreToken
} from '@atoma-js/types/core'
import type { EntityId } from '@atoma-js/types/shared'
import type { StoreMap } from '@atoma-js/types/runtime'
import { read } from '@atoma-js/shared'
import { runQuery } from '@atoma-js/core/query'
import {
    buildRelationPlan,
    extractKeyValue,
    pickFirstKey,
    type IncludeInput,
    type RelationPlanEntry
} from '@atoma-js/core/relations'

type RelationStoreStates = ReadonlyMap<StoreToken, StoreMap>
type RelationType = RelationPlanEntry<Entity>['relation']['type']

const DEFAULT_STABLE_SORT: SortRule[] = [{ field: 'id', dir: 'asc' }]

const createEqFilter = (field: string, value: EntityId): FilterExpr => ({
    op: 'eq',
    field,
    value
})

const getDefaultRelationValue = (relationType: RelationType): null | [] => {
    return relationType === 'hasMany' ? [] : null
}

const setRelationValue = <T extends Entity>(item: T, relationName: string, value: unknown) => {
    const target = item as unknown as Record<string, unknown>
    target[relationName] = value
}

const toEntityId = (value: unknown): EntityId | undefined => {
    return typeof value === 'string' ? value : undefined
}

const resolveLookupMode = (
    indexes: Indexes<Entity> | null,
    targetKeyField: string,
    key: EntityId
): 'index' | 'scan' => {
    if (!indexes) return 'scan'
    const probe = indexes.query(createEqFilter(targetKeyField, key))
    return probe.kind === 'scan' ? 'scan' : 'index'
}

function buildTargetLookup(
    map: ReadonlyMap<EntityId, Entity>,
    indexes: Indexes<Entity> | null,
    targetKeyField: string
): (key: EntityId) => Entity[] {
    let lookupMode: 'index' | 'scan' | undefined
    let bucket: Map<EntityId, Entity[]> | undefined
    const perKeyCache = new Map<EntityId, Entity[]>()

    return (key: EntityId) => {
        const cached = perKeyCache.get(key)
        if (cached) return cached

        if (!lookupMode) {
            lookupMode = resolveLookupMode(indexes, targetKeyField, key)
        }

        if (lookupMode === 'index' && indexes) {
            const res = indexes.query(createEqFilter(targetKeyField, key))
            if (res.kind === 'scan') {
                lookupMode = 'scan'
            } else {
                const output: Entity[] = []
                for (const id of res.ids) {
                    const target = map.get(id)
                    if (target) output.push(target)
                }
                perKeyCache.set(key, output)
                return output
            }
        }

        if (!bucket) {
            const next = new Map<EntityId, Entity[]>()
            map.forEach(target => {
                const targetKey = toEntityId(read(target, targetKeyField))
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
}

type ProjectContext<TSource extends Entity> = Readonly<{
    items: TSource[]
    relationName: string
    relationType: RelationType
    sourceKeySelector: KeySelector<TSource>
    targetKeyField: string
    query: RelationQuery<unknown>
    store: StoreToken
}>

function buildProjectContext<TSource extends Entity>(entry: RelationPlanEntry<TSource>): ProjectContext<TSource> {
    const relationType = entry.relation.type
    return {
        items: entry.items,
        relationName: entry.relationName,
        relationType,
        sourceKeySelector: relationType === 'belongsTo'
            ? entry.relation.foreignKey
            : (entry.relation.primaryKey || 'id'),
        targetKeyField: relationType === 'belongsTo'
            ? (entry.relation.primaryKey || 'id')
            : entry.relation.foreignKey,
        query: entry.query,
        store: entry.relation.store
    }
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
        projectPlanned(entry, storeStates)
    })

    return results
}

function projectPlanned<TSource extends Entity>(
    entry: RelationPlanEntry<TSource>,
    storeStates: RelationStoreStates
) {
    const context = buildProjectContext(entry)
    const runtime = storeStates.get(context.store)
    const map = runtime?.map
    const indexes = runtime?.indexes ?? null

    if (!map) {
        context.items.forEach(item => {
            setRelationValue(item, context.relationName, getDefaultRelationValue(context.relationType))
        })
        return
    }

    if (context.relationType === 'belongsTo') {
        projectBelongsTo(context, map, indexes)
        return
    }

    projectHasManyOrHasOne(context, map, indexes)
}

function projectBelongsTo<TSource extends Entity>(
    context: ProjectContext<TSource>,
    map: ReadonlyMap<EntityId, Entity>,
    indexes: Indexes<Entity> | null
) {
    const getTargetsByKey = context.targetKeyField === 'id'
        ? (key: EntityId) => {
            const direct = map.get(key)
            return direct ? [direct] : []
        }
        : buildTargetLookup(map, indexes, context.targetKeyField)

    context.items.forEach(item => {
        const fk = pickFirstKey(extractKeyValue(item, context.sourceKeySelector))
        const target = fk !== undefined ? getTargetsByKey(fk)[0] : undefined
        setRelationValue(item, context.relationName, target ?? null)
    })
}

function projectHasManyOrHasOne<TSource extends Entity>(
    context: ProjectContext<TSource>,
    map: ReadonlyMap<EntityId, Entity>,
    indexes: Indexes<Entity> | null
) {
    const isHasOne = context.relationType === 'hasOne'
    const sortRules = context.query.sort?.length
        ? context.query.sort
        : DEFAULT_STABLE_SORT
    const getTargetsByKey = buildTargetLookup(map, indexes, context.targetKeyField)
    const orderedCache = new Map<string, Entity[]>()

    const getOrderedTargets = (targets: Entity[]): Entity[] => {
        const cacheKey = targets.map(target => target.id).sort().join('\u0000')
        const cached = orderedCache.get(cacheKey)
        if (cached) return cached

        const ordered = runQuery({
            snapshot: new Map(targets.map(target => [target.id, target] as const)),
            query: { sort: sortRules },
            indexes: null
        }).data

        orderedCache.set(cacheKey, ordered)
        return ordered
    }

    context.items.forEach(item => {
        const keyValue = extractKeyValue(item, context.sourceKeySelector)
        if (keyValue === undefined) {
            setRelationValue(item, context.relationName, isHasOne ? null : [])
            return
        }

        const keys = Array.isArray(keyValue) ? keyValue : [keyValue]
        const merged: Entity[] = []
        keys.forEach(key => {
            const list = getTargetsByKey(key)
            if (list.length) merged.push(...list)
        })

        const deduped = dedupeById(merged)
        if (deduped.length === 0) {
            setRelationValue(item, context.relationName, isHasOne ? null : [])
            return
        }

        const ordered = getOrderedTargets(deduped)
        const limit = isHasOne ? 1 : context.query.limit
        const projected = limit === undefined ? ordered : ordered.slice(0, limit)

        setRelationValue(item, context.relationName, isHasOne
            ? (projected[0] ?? null)
            : projected)
    })
}
