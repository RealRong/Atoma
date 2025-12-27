import type {
    Entity,
    FindManyOptions,
    KeySelector,
    RelationConfig,
    RelationMap,
    StoreKey,
    StoreToken,
    VariantsConfig
} from '../types'
import { applyQuery } from '../query'
import { getValueByPath } from './utils'

export type GetStoreMap = (store: StoreToken) => Map<StoreKey, any> | undefined

type IncludeInput = Record<string, boolean | FindManyOptions<any>> | undefined

type RelationShape<TSource> =
    | {
        kind: 'belongsTo'
        store: StoreToken
        sourceKeySelector: KeySelector<TSource>
        targetKeyField: string
        options: Pick<FindManyOptions<any>, 'orderBy' | 'limit'>
    }
    | {
        kind: 'hasMany'
        store: StoreToken
        sourceKeySelector: KeySelector<TSource>
        targetKeyField: string
        options: Pick<FindManyOptions<any>, 'orderBy' | 'limit'>
    }
    | {
        kind: 'hasOne'
        store: StoreToken
        sourceKeySelector: KeySelector<TSource>
        targetKeyField: string
        options: Pick<FindManyOptions<any>, 'orderBy' | 'limit'>
    }

const getDefaultValue = (config: RelationConfig<any, any> | undefined) => {
    if (!config) return null
    if (config.type === 'hasMany') return []
    return null
}

const extractKeyValue = <T>(item: T, selector: KeySelector<T>): StoreKey | StoreKey[] | undefined | null => {
    if (typeof selector === 'function') return selector(item)
    return getValueByPath(item, selector)
}

const pickFirstKey = (value: StoreKey | StoreKey[] | undefined | null): StoreKey | undefined => {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) return value
    for (const v of value) {
        if (v !== undefined && v !== null) return v
    }
    return undefined
}

const normalizeIncludeOptions = (
    configOptions: FindManyOptions<any> | undefined,
    includeValue: boolean | FindManyOptions<any>
): Pick<FindManyOptions<any>, 'orderBy' | 'limit'> => {
    const user = typeof includeValue === 'object' ? includeValue : undefined
    return {
        orderBy: user?.orderBy !== undefined ? user.orderBy : configOptions?.orderBy,
        limit: user?.limit !== undefined ? user.limit : configOptions?.limit
    }
}

const toRelationShape = <TSource>(
    config: Exclude<RelationConfig<TSource, any>, VariantsConfig<TSource>>,
    includeValue: boolean | FindManyOptions<any>
): RelationShape<TSource> => {
    const options = normalizeIncludeOptions((config as any).options, includeValue)

    if (config.type === 'belongsTo') {
        return {
            kind: 'belongsTo',
            store: config.store,
            sourceKeySelector: config.foreignKey,
            targetKeyField: String(config.primaryKey || 'id'),
            options
        }
    }

    return {
        kind: config.type,
        store: config.store,
        sourceKeySelector: config.primaryKey || 'id',
        targetKeyField: config.foreignKey,
        options
    }
}

export function collectRelationStoreTokens<T extends Entity>(
    include: IncludeInput,
    relations: RelationMap<T> | undefined
): StoreToken[] {
    if (!include || !relations) return []

    const set = new Set<StoreToken>()

    Object.entries(include).forEach(([name, value]) => {
        if (value === false || value === undefined || value === null) return
        const config = relations[name]
        if (!config) return

        if (config.type === 'variants') {
            config.branches.forEach(branch => set.add(branch.relation.store))
            return
        }

        set.add(config.store)
    })

    return Array.from(set)
}

export function projectRelationsBatch<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined,
    getStoreMap: GetStoreMap
): T[] {
    if (!items.length || !include || !relations) return items

    const results = items.map(item => ({ ...item })) as T[]

    Object.entries(include).forEach(([relName, relOpts]) => {
        if (relOpts === false || relOpts === undefined || relOpts === null) return
        const config = relations[relName]
        if (!config) return

        if (config.type === 'variants') {
            projectVariants(results, relName, config, relOpts, getStoreMap)
            return
        }

        projectStandard(results, relName, config as any, relOpts, getStoreMap)
    })

    return results
}

function projectVariants<T extends Entity>(
    results: T[],
    relName: string,
    config: VariantsConfig<T>,
    relOpts: boolean | FindManyOptions<any>,
    getStoreMap: GetStoreMap
) {
    const branchGroups = new Map<number, T[]>()

    results.forEach(item => {
        const idx = config.branches.findIndex(b => b.when(item))
        if (idx < 0) {
            ;(item as any)[relName] = null
            return
        }
        const group = branchGroups.get(idx) || []
        group.push(item)
        branchGroups.set(idx, group)
    })

    branchGroups.forEach((group, idx) => {
        const branch = config.branches[idx]
        projectStandard(group, relName, branch.relation as any, relOpts, getStoreMap)
    })
}

function projectStandard<TSource extends Entity>(
    results: TSource[],
    relName: string,
    config: Exclude<RelationConfig<TSource, any>, VariantsConfig<TSource>>,
    relOpts: boolean | FindManyOptions<any>,
    getStoreMap: GetStoreMap
) {
    const shape = toRelationShape(config, relOpts)

    const map = getStoreMap(shape.store)
    if (!map) {
        results.forEach(item => {
            ;(item as any)[relName] = getDefaultValue(config)
        })
        return
    }

    if (shape.kind === 'belongsTo') {
        if (shape.targetKeyField === 'id') {
            results.forEach(item => {
                const fk = pickFirstKey(extractKeyValue(item, shape.sourceKeySelector))
                const target = fk !== undefined ? map.get(fk) : undefined
                ;(item as any)[relName] = target ?? null
            })
            return
        }

        const index = new Map<StoreKey, any>()
        map.forEach(target => {
            const key = (target as any)?.[shape.targetKeyField] as StoreKey | undefined | null
            if (key === undefined || key === null) return
            if (!index.has(key)) index.set(key, target)
        })

        results.forEach(item => {
            const fk = pickFirstKey(extractKeyValue(item, shape.sourceKeySelector))
            const target = fk !== undefined ? index.get(fk) : undefined
            ;(item as any)[relName] = target ?? null
        })
        return
    }

    const bucket = new Map<StoreKey, any[]>()
    map.forEach(target => {
        const key = (target as any)?.[shape.targetKeyField] as StoreKey | undefined | null
        if (key === undefined || key === null) return
        const arr = bucket.get(key) || []
        arr.push(target)
        bucket.set(key, arr)
    })

    results.forEach(item => {
        const keyValue = extractKeyValue(item, shape.sourceKeySelector)
        if (keyValue === undefined || keyValue === null) {
            ;(item as any)[relName] = getDefaultValue(config)
            return
        }

        const keys = Array.isArray(keyValue) ? keyValue : [keyValue]
        const matches: any[] = []
        keys.forEach(k => {
            const arr = bucket.get(k)
            if (arr) matches.push(...arr)
        })

        const projected = applyQuery(matches, {
            orderBy: shape.options.orderBy,
            limit: shape.kind === 'hasOne'
                ? 1
                : shape.options.limit
        })

        ;(item as any)[relName] = shape.kind === 'hasOne'
            ? (projected[0] ?? null)
            : projected
    })
}

