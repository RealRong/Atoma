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
import { mergeIncludeQuery, resolveLimit } from './utils/includeQuery'
import { collectUniqueKeys } from './utils/key'

export type IncludeInput = Record<string, boolean | Query<unknown>> | undefined

export type StandardRelationConfig<T extends Entity> = Exclude<RelationConfig<T, Entity>, VariantsConfig<T>>

export type PlannedRelation<T extends Entity> = Readonly<{
    relationName: string
    includeValue: boolean | Query<unknown>
    relationType: 'belongsTo' | 'hasMany' | 'hasOne'
    relation: StandardRelationConfig<T>
    items: T[]
    store: StoreToken
    sourceKeySelector: KeySelector<T>
    targetKeyField: string
    uniqueKeys: EntityId[]
    mergedQuery: Query<unknown>
    projectionOptions: {
        sort?: SortRule[]
        limit?: number
    }
}>

function getRelationOptions<T extends Entity>(relation: StandardRelationConfig<T>): Query<unknown> | undefined {
    return (relation as { options?: Query<unknown> }).options
}

export function collectRelationStoreTokensFromInclude<T extends Entity>(
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

export function buildRelationPlan<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): PlannedRelation<T>[] {
    if (!items.length || !include || !relations) return []

    const output: PlannedRelation<T>[] = []

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
                output.push(buildStandardPlan(group, relationName, includeValue, branch.relation as StandardRelationConfig<T>))
            })
            return
        }

        output.push(buildStandardPlan(items, relationName, includeValue, relation as StandardRelationConfig<T>))
    })

    return output
}

function buildStandardPlan<T extends Entity>(
    items: T[],
    relationName: string,
    includeValue: boolean | Query<unknown>,
    relation: StandardRelationConfig<T>
): PlannedRelation<T> {
    const sourceKeySelector: KeySelector<T> = relation.type === 'belongsTo'
        ? relation.foreignKey
        : relation.primaryKey || 'id'

    const mergedQuery = mergeIncludeQuery(
        getRelationOptions(relation),
        typeof includeValue === 'object' ? includeValue : undefined
    )

    return {
        relationName,
        includeValue,
        relationType: relation.type,
        relation,
        items,
        store: relation.store,
        sourceKeySelector,
        targetKeyField: getTargetKeyField(relation),
        uniqueKeys: collectUniqueKeys(items, sourceKeySelector),
        mergedQuery,
        projectionOptions: {
            sort: mergedQuery.sort,
            limit: resolveLimit(mergedQuery.page)
        }
    }
}

function getTargetKeyField<T extends Entity>(config: StandardRelationConfig<T>): string {
    return config.type === 'belongsTo'
        ? (config.primaryKey || 'id')
        : config.foreignKey
}
