import type {
    Entity,
    KeySelector,
    RelationQuery,
    RelationIncludeInput,
    RelationConfig,
    RelationMap,
    StoreToken,
    VariantsConfig
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { mergeIncludeQuery, pickIncludeOptions } from './include'
import { collectUniqueKeys } from './key'

export type IncludeInput = RelationIncludeInput<Record<string, unknown>> | undefined

export type StandardRelationConfig<T extends Entity> = Exclude<RelationConfig<T, Entity>, VariantsConfig<T>>

type RelationType = StandardRelationConfig<Entity>['type']

export type RelationPlanEntry<T extends Entity> = Readonly<{
    relationName: string
    relationType: RelationType
    items: T[]
    store: StoreToken
    sourceKeySelector: KeySelector<T>
    targetKeyField: string
    uniqueKeys: EntityId[]
    query: RelationQuery<unknown>
}>

export function collectPlanStoreTokens<T extends Entity>(entries: RelationPlanEntry<T>[]): StoreToken[] {
    const output = new Set<StoreToken>()
    entries.forEach(entry => {
        output.add(entry.store)
    })

    return Array.from(output)
}

type PlannableRelation<T extends Entity> = Readonly<{
    relationName: string
    includeValue: unknown
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

export function buildRelationPlan<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): RelationPlanEntry<T>[] {
    if (!items.length || !include || !relations) return []

    const output: RelationPlanEntry<T>[] = []
    forEachPlannableRelation(items, include, relations, ({ relationName, includeValue, relation, items }) => {
        const sourceKeySelector = getSourceKeySelector(relation)
        const relationOptions = pickIncludeOptions((relation as { options?: unknown }).options)
        const includeOptions = pickIncludeOptions(includeValue)
        const query = mergeIncludeQuery(
            relationOptions.query,
            includeOptions.query
        )
        output.push({
            relationName,
            relationType: relation.type,
            items,
            store: relation.store,
            sourceKeySelector,
            targetKeyField: getTargetKeyField(relation),
            uniqueKeys: collectUniqueKeys(items, sourceKeySelector),
            query
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
