import type {
    Entity,
    Query,
    KeySelector,
    RelationConfig,
    RelationMap,
    StoreToken,
    VariantsConfig
} from '../types'
import type { EntityId } from '#protocol'
import type { StoreIndexes } from '../indexes/StoreIndexes'
import { executeLocalQuery } from '../query'
import { getValueByPath } from './utils'

export type StoreRuntime = {
    map: Map<EntityId, any>
    indexes?: StoreIndexes<any> | null
}

export type GetStoreMap = (store: StoreToken) => Map<EntityId, any> | StoreRuntime | undefined

type IncludeInput = Record<string, boolean | Query<any>> | undefined

type RelationShape<TSource> =
    | {
        kind: 'belongsTo'
        store: StoreToken
        sourceKeySelector: KeySelector<TSource>
        targetKeyField: string
        options: { sort?: any[]; limit?: number }
    }
    | {
        kind: 'hasMany'
        store: StoreToken
        sourceKeySelector: KeySelector<TSource>
        targetKeyField: string
        options: { sort?: any[]; limit?: number }
    }
    | {
        kind: 'hasOne'
        store: StoreToken
        sourceKeySelector: KeySelector<TSource>
        targetKeyField: string
        options: { sort?: any[]; limit?: number }
    }

const getDefaultValue = (config: RelationConfig<any, any> | undefined) => {
    if (!config) return null
    if (config.type === 'hasMany') return []
    return null
}

const extractKeyValue = <T>(item: T, selector: KeySelector<T>): EntityId | EntityId[] | undefined | null => {
    if (typeof selector === 'function') return selector(item)
    return getValueByPath(item, selector)
}

const pickFirstKey = (value: EntityId | EntityId[] | undefined | null): EntityId | undefined => {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) return value
    for (const v of value) {
        if (v !== undefined && v !== null) return v
    }
    return undefined
}

const normalizeIncludeOptions = (
    configOptions: Query<any> | undefined,
    includeValue: boolean | Query<any>
): { sort?: any[]; limit?: number } => {
    const user = typeof includeValue === 'object' ? includeValue : undefined
    const userLimit = user?.page && (user.page as any).limit !== undefined
        ? (user.page as any).limit
        : undefined
    const configLimit = configOptions?.page && (configOptions.page as any).limit !== undefined
        ? (configOptions.page as any).limit
        : undefined
    return {
        sort: user?.sort !== undefined ? user.sort : configOptions?.sort,
        limit: userLimit !== undefined ? userLimit : configLimit
    }
}

const toRelationShape = <TSource>(
    config: Exclude<RelationConfig<TSource, any>, VariantsConfig<TSource>>,
    includeValue: boolean | Query<any>
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
    relOpts: boolean | Query<any>,
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
    relOpts: boolean | Query<any>,
    getStoreMap: GetStoreMap
) {
    const shape = toRelationShape(config, relOpts)

    const runtime = getStoreMap(shape.store)
    const map = runtime instanceof Map
        ? runtime
        : runtime?.map
    const indexes = runtime instanceof Map
        ? null
        : runtime?.indexes ?? null

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

        let lookupMode: 'index' | 'scan' | undefined
        const scannedIndex = new Map<EntityId, any>()
        const pickedByKey = new Map<EntityId, any>()

        const getTargetByKey = (key: EntityId): any | undefined => {
            const cached = pickedByKey.get(key)
            if (cached !== undefined) return cached

            if (!lookupMode && indexes) {
                const probe = indexes.collectCandidates({ [shape.targetKeyField]: { eq: key } } as any)
                lookupMode = probe.kind === 'unsupported' ? 'scan' : 'index'
            }

            if (lookupMode === 'index' && indexes) {
                const res = indexes.collectCandidates({ [shape.targetKeyField]: { eq: key } } as any)
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
                    const k = (target as any)?.[shape.targetKeyField] as EntityId | undefined | null
                    if (k === undefined || k === null) return
                    if (!scannedIndex.has(k)) scannedIndex.set(k, target)
                })
            }
            const target = scannedIndex.get(key)
            pickedByKey.set(key, target ?? null)
            return target
        }

        results.forEach(item => {
            const fk = pickFirstKey(extractKeyValue(item, shape.sourceKeySelector))
            const target = fk !== undefined ? getTargetByKey(fk) : undefined
            ;(item as any)[relName] = target ?? null
        })
        return
    }

    let bucket: Map<EntityId, any[]> | null = null
    let keyLookupMode: 'index' | 'scan' | undefined
    const perKeyCache = new Map<EntityId, any[]>()

    const getTargetsByKey = (key: EntityId): any[] => {
        const cached = perKeyCache.get(key)
        if (cached) return cached

        if (!keyLookupMode && indexes) {
            const probe = indexes.collectCandidates({ [shape.targetKeyField]: { eq: key } } as any)
            keyLookupMode = probe.kind === 'unsupported' ? 'scan' : 'index'
        }

        if (keyLookupMode === 'index' && indexes) {
            const res = indexes.collectCandidates({ [shape.targetKeyField]: { eq: key } } as any)
            if (res.kind !== 'candidates') {
                perKeyCache.set(key, [])
                return []
            }
            const out: any[] = []
            for (const id of res.ids) {
                const target = map.get(id)
                if (target) out.push(target)
            }
            perKeyCache.set(key, out)
            return out
        }

        if (keyLookupMode !== 'scan') keyLookupMode = 'scan'
        if (!bucket) {
            const next = new Map<EntityId, any[]>()
            map.forEach(target => {
                const k = (target as any)?.[shape.targetKeyField] as EntityId | undefined | null
                if (k === undefined || k === null) return
                const arr = next.get(k) || []
                arr.push(target)
                next.set(k, arr)
            })
            bucket = next
        }
        const out = bucket.get(key) || []
        perKeyCache.set(key, out)
        return out
    }

    results.forEach(item => {
        const keyValue = extractKeyValue(item, shape.sourceKeySelector)
        if (keyValue === undefined || keyValue === null) {
            ;(item as any)[relName] = getDefaultValue(config)
            return
        }

        const keys = Array.isArray(keyValue) ? keyValue : [keyValue]
        const matches: any[] = []
        keys.forEach(k => {
            if (k === undefined || k === null) return
            const arr = getTargetsByKey(k)
            if (arr.length) matches.push(...arr)
        })

        const sort = shape.options.sort
        if (shape.kind === 'hasOne' && !sort) {
            ;(item as any)[relName] = matches[0] ?? null
            return
        }

        const limit = shape.kind === 'hasOne' ? 1 : shape.options.limit
        if (!sort) {
            ;(item as any)[relName] = shape.kind === 'hasOne'
                ? (matches[0] ?? null)
                : (limit === undefined ? matches : matches.slice(0, limit))
            return
        }

        const projected = executeLocalQuery(matches as any, {\n            sort: sort as any,\n            page: { mode: 'offset', limit }\n        } as any).data

        ;(item as any)[relName] = shape.kind === 'hasOne'
            ? (projected[0] ?? null)
            : projected
    })
}
