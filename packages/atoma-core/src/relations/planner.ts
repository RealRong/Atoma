import type {
    Entity,
    KeySelector,
    Query,
    RelationConfig,
    RelationMap,
    StoreToken,
    VariantsConfig
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { getValueByPath } from './utils'

export type IncludeInput = Record<string, boolean | Query<any>> | undefined

export type StandardRelationConfig<T extends Entity> = Exclude<RelationConfig<T, any>, VariantsConfig<T>>

export type PlannedRelation<T extends Entity> = Readonly<{
    relationName: string
    includeValue: boolean | Query<any>
    relationType: 'belongsTo' | 'hasMany' | 'hasOne'
    relation: StandardRelationConfig<T>
    items: T[]
    store: StoreToken
    sourceKeySelector: KeySelector<T>
    targetKeyField: string
    uniqueKeys: EntityId[]
    mergedQuery: Query<any>
    projectionOptions: {
        sort?: any[]
        limit?: number
    }
}>

export function collectRelationStoreTokensFromInclude<T extends Entity>(
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): StoreToken[] {
    if (!include || !relations) return []

    const out = new Set<StoreToken>()

    Object.entries(include).forEach(([name, value]) => {
        if (value === false || value === undefined || value === null) return
        const relation = relations[name]
        if (!relation) return

        if (relation.type === 'variants') {
            relation.branches.forEach(branch => {
                out.add(branch.relation.store)
            })
            return
        }

        out.add(relation.store)
    })

    return Array.from(out)
}

export function buildRelationPlan<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): PlannedRelation<T>[] {
    if (!items.length || !include || !relations) return []

    const out: PlannedRelation<T>[] = []

    Object.entries(include).forEach(([relationName, includeValue]) => {
        if (includeValue === false || includeValue === undefined || includeValue === null) return

        const relation = relations[relationName]
        if (!relation) return

        if (relation.type === 'variants') {
            const grouped = new Map<number, T[]>()
            items.forEach(item => {
                const index = relation.branches.findIndex(branch => branch.when(item))
                if (index < 0) return
                const group = grouped.get(index) || []
                group.push(item)
                grouped.set(index, group)
            })

            grouped.forEach((group, branchIndex) => {
                const branch = relation.branches[branchIndex]
                const planned = buildStandardPlan(group, relationName, includeValue, branch.relation as StandardRelationConfig<T>)
                out.push(planned)
            })
            return
        }

        out.push(buildStandardPlan(items, relationName, includeValue, relation as StandardRelationConfig<T>))
    })

    return out
}

function buildStandardPlan<T extends Entity>(
    items: T[],
    relationName: string,
    includeValue: boolean | Query<any>,
    relation: StandardRelationConfig<T>
): PlannedRelation<T> {
    const sourceKeySelector: KeySelector<T> = relation.type === 'belongsTo'
        ? relation.foreignKey
        : relation.primaryKey || 'id'

    const mergedQuery = mergeQuery(
        (relation as any).options,
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
        uniqueKeys: collectKeys(items, sourceKeySelector),
        mergedQuery,
        projectionOptions: {
            sort: mergedQuery.sort as any[] | undefined,
            limit: resolveLimit(mergedQuery.page)
        }
    }
}

function getTargetKeyField(config: StandardRelationConfig<any>): string {
    return config.type === 'belongsTo'
        ? (config.primaryKey as string) || 'id'
        : config.foreignKey
}

function resolveLimit(page: any): number | undefined {
    const raw = page && typeof page === 'object' ? (page as any).limit : undefined
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
    return Math.max(0, Math.floor(raw))
}

function collectKeys<T extends Entity>(items: T[], selector: KeySelector<T>): EntityId[] {
    const out = new Set<EntityId>()

    items.forEach(item => {
        const keyValue = extractKeyValue(item, selector)
        if (keyValue === undefined || keyValue === null) return

        if (Array.isArray(keyValue)) {
            keyValue.forEach(key => {
                if (key === undefined || key === null) return
                out.add(key)
            })
            return
        }

        out.add(keyValue)
    })

    return Array.from(out)
}

function extractKeyValue<T>(item: T, selector: KeySelector<T>): EntityId | EntityId[] | undefined | null {
    if (typeof selector === 'function') return selector(item)
    if (typeof selector === 'string') return getValueByPath(item, selector)
    return undefined
}

function mergeQuery(base?: Query<any>, override?: Query<any>): Query<any> {
    if (!base && !override) return {}
    if (!base) return { ...override }
    if (!override) return { ...base }

    const filter = base.filter && override.filter
        ? ({ op: 'and', args: [base.filter, override.filter] } as any)
        : (override.filter ?? base.filter)

    return {
        filter,
        sort: override.sort !== undefined ? override.sort : base.sort,
        select: override.select !== undefined ? override.select : base.select,
        include: override.include !== undefined ? override.include : base.include,
        page: override.page !== undefined ? override.page : base.page
    }
}
