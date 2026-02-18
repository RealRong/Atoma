import type {
    Entity,
    KeySelector,
    Query,
    RelationConfig,
    RelationMap,
    SortRule,
    StoreToken,
    VariantsConfig
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { mergeIncludeQuery, pickIncludeQuery, resolveLimit } from './include'
import { collectUniqueKeys } from './key'

export type IncludeInput = Record<string, boolean | Query<unknown>> | undefined

export type StandardRelationConfig<T extends Entity> = Exclude<RelationConfig<T, Entity>, VariantsConfig<T>>

type RelationType = StandardRelationConfig<Entity>['type']

export type PrefetchPlanEntry = Readonly<{
    relationName: string
    relationType: RelationType
    store: StoreToken
    targetKeyField: string
    includeQuery: Query<unknown> | undefined
    relationQuery: Query<unknown> | undefined
    uniqueKeys: EntityId[]
    query: Query<unknown>
}>

export type ProjectPlanEntry<T extends Entity> = Readonly<{
    relationName: string
    relationType: RelationType
    items: T[]
    store: StoreToken
    sourceKeySelector: KeySelector<T>
    targetKeyField: string
    sort: SortRule[] | undefined
    limit: number | undefined
}>

function getRelationOptions<T extends Entity>(relation: StandardRelationConfig<T>): Query<unknown> | undefined {
    return (relation as { options?: Query<unknown> }).options
}

function getIncludeQuery(includeValue: boolean | Query<unknown>): Query<unknown> | undefined {
    return typeof includeValue === 'object'
        ? pickIncludeQuery(includeValue)
        : undefined
}

export function collectRelationStoreTokens<T extends Entity>(
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): StoreToken[] {
    if (!include || !relations) return []

    const output = new Set<StoreToken>()

    Object.entries(include).forEach(([name, value]) => {
        if (value === false || value === undefined || value === null) return

        const relation = relations[name]
        if (!relation) return

        if (relation.type === 'variants') {
            relation.branches.forEach(branch => {
                output.add(branch.relation.store)
            })
            return
        }

        output.add(relation.store)
    })

    return Array.from(output)
}

type PlannableRelation<T extends Entity> = Readonly<{
    relationName: string
    includeValue: boolean | Query<unknown>
    relation: StandardRelationConfig<T>
    items: T[]
}>

function forEachPlannableRelation<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined,
    run: (entry: PlannableRelation<T>) => void
) {
    if (!items.length || !include || !relations) return

    Object.entries(include).forEach(([relationName, includeValue]) => {
        if (includeValue === false || includeValue === undefined || includeValue === null) return

        const relation = relations[relationName]
        if (!relation) return

        if (relation.type === 'variants') {
            const grouped = new Map<number, T[]>()
            items.forEach(item => {
                const branchIndex = relation.branches.findIndex(branch => branch.when(item))
                if (branchIndex < 0) return

                const group = grouped.get(branchIndex) || []
                group.push(item)
                grouped.set(branchIndex, group)
            })

            grouped.forEach((group, branchIndex) => {
                const branch = relation.branches[branchIndex]
                run({
                    relationName,
                    includeValue,
                    relation: branch.relation as StandardRelationConfig<T>,
                    items: group
                })
            })
            return
        }

        run({
            relationName,
            includeValue,
            relation: relation as StandardRelationConfig<T>,
            items
        })
    })
}

export function buildPrefetchPlan<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): PrefetchPlanEntry[] {
    if (!items.length || !include || !relations) return []

    const output: PrefetchPlanEntry[] = []
    forEachPlannableRelation(items, include, relations, ({ relationName, includeValue, relation, items }) => {
        const sourceKeySelector = getSourceKeySelector(relation)
        const includeQuery = getIncludeQuery(includeValue)
        const relationQuery = pickIncludeQuery(getRelationOptions(relation))
        output.push({
            relationName,
            relationType: relation.type,
            store: relation.store,
            targetKeyField: getTargetKeyField(relation),
            includeQuery,
            relationQuery,
            uniqueKeys: collectUniqueKeys(items, sourceKeySelector),
            query: mergeIncludeQuery(relationQuery, includeQuery)
        })
    })

    return output
}

export function buildProjectPlan<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): ProjectPlanEntry<T>[] {
    if (!items.length || !include || !relations) return []

    const output: ProjectPlanEntry<T>[] = []
    forEachPlannableRelation(items, include, relations, ({ relationName, includeValue, relation, items }) => {
        const sourceKeySelector = getSourceKeySelector(relation)
        const query = mergeIncludeQuery(
            getRelationOptions(relation),
            getIncludeQuery(includeValue)
        )
        output.push({
            relationName,
            relationType: relation.type,
            items,
            store: relation.store,
            sourceKeySelector,
            targetKeyField: getTargetKeyField(relation),
            sort: query.sort,
            limit: resolveLimit(query.page)
        })
    })

    return output
}

function getSourceKeySelector<T extends Entity>(relation: StandardRelationConfig<T>): KeySelector<T> {
    return relation.type === 'belongsTo'
        ? relation.foreignKey
        : relation.primaryKey || 'id'
}

function getTargetKeyField<T extends Entity>(config: StandardRelationConfig<T>): string {
    return config.type === 'belongsTo'
        ? (config.primaryKey || 'id')
        : config.foreignKey
}
