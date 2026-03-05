import type {
    Entity,
    RelationQuery,
    RelationIncludeInput,
    RelationConfig,
    RelationMap,
    StoreToken,
    VariantsConfig
} from 'atoma-types/core'
import { mergeIncludeQuery, pickIncludeOptions } from './include'

export type IncludeInput = RelationIncludeInput<Record<string, unknown>> | undefined

type RelationNode<T extends Entity> = Exclude<RelationConfig<T, Entity>, VariantsConfig<T>>

export type RelationPlanEntry<T extends Entity> = Readonly<{
    relationName: string
    relation: RelationNode<T>
    items: T[]
    query: RelationQuery<unknown>
}>

export function collectPlanStoreTokens<T extends Entity>(entries: RelationPlanEntry<T>[]): StoreToken[] {
    const output = new Set<StoreToken>()
    entries.forEach(entry => {
        output.add(entry.relation.store)
    })

    return Array.from(output)
}

export function buildRelationPlan<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): RelationPlanEntry<T>[] {
    if (!items.length || !include || !relations) return []

    const output: RelationPlanEntry<T>[] = []
    Object.entries(include).forEach(([relationName, includeValue]) => {
        if (includeValue === false || includeValue === undefined || includeValue === null) return

        const config = relations[relationName]
        if (!config) return

        const includeOptions = pickIncludeOptions(includeValue)

        if (config.type === 'variants') {
            const grouped = new Map<number, T[]>()
            items.forEach(item => {
                const branchIndex = config.branches.findIndex(branch => branch.when(item))
                if (branchIndex < 0) return
                const group = grouped.get(branchIndex) || []
                group.push(item)
                grouped.set(branchIndex, group)
            })

            grouped.forEach((group, branchIndex) => {
                const relation = config.branches[branchIndex].relation as RelationNode<T>
                const relationOptions = pickIncludeOptions((relation as { options?: unknown }).options)
                output.push({
                    relationName,
                    relation,
                    items: group,
                    query: mergeIncludeQuery(relationOptions.query, includeOptions.query)
                })
            })
            return
        }

        const relation = config as RelationNode<T>
        const relationOptions = pickIncludeOptions((relation as { options?: unknown }).options)
        output.push({
            relationName,
            relation,
            items,
            query: mergeIncludeQuery(relationOptions.query, includeOptions.query)
        })
    })

    return output
}
