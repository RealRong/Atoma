import { useMemo } from 'react'
import { buildRelationPlan, collectPlanStoreTokens } from '@atoma-js/core/relations'
import type { RelationPlanEntry } from '@atoma-js/core/relations'
import type { Entity, RelationMap, StoreToken } from '@atoma-js/types/core'
import type { RelationInclude } from '@atoma-js/types/runtime'

export type RelationPlans<T extends Entity> = Readonly<{
    effectiveEntries: RelationPlanEntry<T>[]
    liveEntries: RelationPlanEntry<T>[]
    snapshotEntries: RelationPlanEntry<T>[]
    effectiveTokens: StoreToken[]
    liveTokens: StoreToken[]
    snapshotTokens: StoreToken[]
}>

export function useRelationPlans<T extends Entity>(args: {
    items: T[]
    effectiveInclude: RelationInclude | undefined
    liveInclude: RelationInclude | undefined
    snapshotInclude: RelationInclude | undefined
    relationMap: RelationMap<T> | undefined
}): RelationPlans<T> {
    const { items, effectiveInclude, liveInclude, snapshotInclude, relationMap } = args

    return useMemo(() => {
        const effectiveEntries = buildRelationPlan(items, effectiveInclude, relationMap)
        const liveNames = liveInclude ? new Set(Object.keys(liveInclude)) : undefined
        const snapshotNames = snapshotInclude ? new Set(Object.keys(snapshotInclude)) : undefined
        const liveEntries = liveNames
            ? effectiveEntries.filter((entry) => liveNames.has(entry.relationName))
            : []
        const snapshotEntries = snapshotNames
            ? effectiveEntries.filter((entry) => snapshotNames.has(entry.relationName))
            : []

        return {
            effectiveEntries,
            liveEntries,
            snapshotEntries,
            effectiveTokens: collectPlanStoreTokens(effectiveEntries),
            liveTokens: collectPlanStoreTokens(liveEntries),
            snapshotTokens: collectPlanStoreTokens(snapshotEntries)
        }
    }, [items, effectiveInclude, liveInclude, snapshotInclude, relationMap])
}
