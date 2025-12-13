import {
    Entity,
    FindManyOptions,
    IStore,
    RelationConfig,
    RelationMap,
    StoreKey,
    VariantsConfig
} from '../types'
import { deepMergeWhere, getValueByPath, normalizeKey } from './utils'

export interface ResolveBatchOptions {
    onError?: 'skip' | 'throw' | 'partial'
    timeout?: number
    maxConcurrency?: number
}

export class RelationResolver {
    // cacheKey -> (normalizedKey -> related items[])
    private static relationCache = new Map<string, Map<string, any[]>>()

    static async resolveBatch<T extends Entity>(
        items: T[],
        include: Record<string, boolean | FindManyOptions<any>> | undefined,
        relations: RelationMap<T> | undefined,
        options: ResolveBatchOptions = {}
    ): Promise<T[]> {
        if (!items.length || !include || !relations) return items

        const { onError = 'partial', timeout = 5000, maxConcurrency = 10 } = options
        const results = items.map(item => ({ ...item }))

        await Promise.all(
            Object.entries(include).map(async ([relName, relOpts]) => {
                const controller = new AbortController()
                try {
                    await Promise.race([
                        this.resolveSingleRelation(
                            results,
                            relName,
                            relOpts,
                            relations,
                            maxConcurrency,
                            controller.signal
                        ),
                        new Promise((_, reject) => {
                            setTimeout(() => {
                                controller.abort()
                                reject(new Error(`Relation "${relName}" timeout`))
                            }, timeout)
                        })
                    ])
                } catch (error) {
                    if (onError === 'throw') throw error
                    console.warn(`[Atoma Relations] "${relName}" failed:`, error)
                    if (onError === 'skip') {
                        const config = relations[relName]
                        const defaultValue = this.getDefaultValue(config)
                        results.forEach(item => {
                            (item as any)[relName] = defaultValue
                        })
                    }
                }
            })
        )

        return results
    }

    private static async resolveSingleRelation<T extends Entity>(
        results: T[],
        relName: string,
        relOpts: boolean | FindManyOptions<any>,
        relations: RelationMap<T>,
        maxConcurrency: number,
        signal: AbortSignal
    ): Promise<void> {
        if (signal.aborted) return

        const config = relations[relName]
        if (!config || relOpts === false) return

        const userOptions = typeof relOpts === 'object' ? relOpts : {}
        this.validateIncludeOptions(relName, userOptions)
        if (config.type !== 'variants') {
            this.validateIncludeOptions(relName, config.options)
        }

        if (config.type === 'variants') {
            await this.resolveVariants(results, relName, config, userOptions, maxConcurrency, signal)
            return
        }

        await this.resolveStandardRelation(results, relName, config, userOptions, signal)
    }

    private static async resolveStandardRelation<T extends Entity>(
        results: T[],
        relName: string,
        config: Exclude<RelationConfig<T, any>, VariantsConfig<T>>,
        userOptions: FindManyOptions<any>,
        signal: AbortSignal
    ): Promise<void> {
        if (signal.aborted) return

        const { itemToKeyMap, uniqueKeys } = this.collectKeys(results, config)

        if (uniqueKeys.length === 0) {
            const defaultValue = this.getDefaultValue(config)
            results.forEach(item => {
                (item as any)[relName] = defaultValue
            })
            return
        }

        const mergedOptions = this.mergeQueryOptions(config.options, userOptions)
        const targetKeyField = this.getTargetKeyField(config)
        const bucket = new Map<string, any[]>()
        const normalizedHitKeys = new Set<string>()
        const cacheKey = this.getRelationCacheKey(config.store, relName, targetKeyField, mergedOptions.where)
        const cacheBucket = cacheKey ? (this.relationCache.get(cacheKey) || new Map<string, any[]>()) : undefined
        if (cacheKey && cacheBucket && !this.relationCache.has(cacheKey)) {
            this.relationCache.set(cacheKey, cacheBucket)
        }

        try {
            // 1) 先尝试通过 getMultipleByIds 命中 Store Map（仅适用于按 id 查询的 belongsTo/hasOne）
            let missingKeys = uniqueKeys
            const canUseIdLookup = config.type === 'belongsTo' && !!config.store.getMultipleByIds

            if (canUseIdLookup) {
                const hitItems = await config.store.getMultipleByIds!(uniqueKeys, true)
                hitItems.forEach(item => {
                    const keyVal = normalizeKey((item as any)[targetKeyField] ?? (item as any).id)
                    if (!bucket.has(keyVal)) bucket.set(keyVal, [])
                    bucket.get(keyVal)!.push(item)
                    normalizedHitKeys.add(keyVal)
                })
                missingKeys = uniqueKeys.filter(k => !normalizedHitKeys.has(normalizeKey(k)))
            }

            // 1.5) 关系级缓存（适用于 hasMany/hasOne/belongsTo，但仅在 where 语义可安全复用时启用）
            if (cacheBucket) {
                uniqueKeys.forEach(k => {
                    const nk = normalizeKey(k)
                    if (!cacheBucket.has(nk)) return
                    const cached = cacheBucket.get(nk) || []
                    bucket.set(nk, cached.slice())
                    normalizedHitKeys.add(nk)
                })
                missingKeys = uniqueKeys.filter(k => !normalizedHitKeys.has(normalizeKey(k)))
            }

            // 2) 对缺失键发单次 where-in 查询
            if (missingKeys.length > 0) {
                const batchQuery: FindManyOptions<any> = {
                    ...mergedOptions,
                    skipStore: false,
                    where: deepMergeWhere(mergedOptions.where, { [targetKeyField]: { in: missingKeys } })
                }

                const fetched = await this.executeFindMany(config.store, batchQuery, signal)

                fetched.forEach(item => {
                    const keyVal = normalizeKey((item as any)[targetKeyField])
                    if (!bucket.has(keyVal)) bucket.set(keyVal, [])
                    bucket.get(keyVal)!.push(item)
                })

                // 写入缓存：缺失键即使无结果也缓存为空数组，避免重复查询
                if (cacheBucket) {
                    missingKeys.forEach(k => {
                        const nk = normalizeKey(k)
                        cacheBucket.set(nk, (bucket.get(nk) || []).slice())
                    })
                }
            }

            this.hydrateResults(results, relName, config, itemToKeyMap, bucket)
        } catch (error) {
            if (signal.aborted) return
            throw error
        }
    }

    private static async resolveVariants<T extends Entity>(
        results: T[],
        relName: string,
        config: VariantsConfig<T>,
        userOptions: FindManyOptions<any>,
        maxConcurrency: number,
        signal: AbortSignal
    ): Promise<void> {
        const branchGroups = new Map<number, T[]>()

        results.forEach(item => {
            const idx = config.branches.findIndex(b => b.when(item))
            if (idx >= 0) {
                if (!branchGroups.has(idx)) branchGroups.set(idx, [])
                branchGroups.get(idx)!.push(item)
            } else {
                (item as any)[relName] = null
            }
        })

        await Promise.all(
            Array.from(branchGroups.entries()).map(async ([idx, items]) => {
                const branch = config.branches[idx]
                await this.resolveStandardRelation(items, relName, branch.relation, userOptions, signal)
            })
        )
    }

    private static collectKeys<T extends Entity>(
        items: T[],
        config: Exclude<RelationConfig<T, any>, VariantsConfig<T>>
    ): { itemToKeyMap: Map<StoreKey, StoreKey | StoreKey[]>; uniqueKeys: StoreKey[] } {
        const rawKeys = new Set<StoreKey>()
        const itemToKeyMap = new Map<StoreKey, StoreKey | StoreKey[]>()

        const keySelector = config.type === 'belongsTo'
            ? config.foreignKey
            : config.primaryKey || 'id'

        items.forEach(item => {
            const keyValue = this.extractKeyValue(item, keySelector)
            if (keyValue === undefined || keyValue === null) return

            if (Array.isArray(keyValue)) {
                keyValue.forEach(v => rawKeys.add(v))
            } else {
                rawKeys.add(keyValue)
            }
            itemToKeyMap.set(item.id, keyValue)
        })

        return {
            itemToKeyMap,
            uniqueKeys: Array.from(rawKeys)
        }
    }

    private static extractKeyValue<T>(item: T, selector: string | ((item: T) => any)): StoreKey | StoreKey[] | undefined | null {
        if (typeof selector === 'function') return selector(item)
        if (typeof selector === 'string') {
            return getValueByPath(item, selector)
        }
        return undefined
    }

    private static async executeFindMany<T extends Entity>(
        store: IStore<T>,
        options: FindManyOptions<T>,
        signal: AbortSignal
    ): Promise<T[]> {
        if (signal.aborted) return []

        if (store.findMany) {
            try {
                const res = await store.findMany(options)
                return Array.isArray(res) ? res : res.data
            } catch (error) {
                if (signal.aborted) return []
                console.warn('[Atoma Relations] findMany failed, fallback to getAll')
            }
        }

        if (options.where && 'id' in options.where) {
            const idCond: any = (options.where as any).id
            if (idCond && typeof idCond === 'object' && 'in' in idCond && store.getMultipleByIds) {
                try {
                    const items = await store.getMultipleByIds(idCond.in as StoreKey[], false)
                    return this.applyQueryLocal(items, options)
                } catch (error) {
                    if (signal.aborted) return []
                }
            }
        }

        try {
            const all = await store.getAll()
            return this.applyQueryLocal(all, options)
        } catch (error) {
            if (signal.aborted) return []
            console.error('[Atoma Relations] All fallback mechanisms failed:', error)
            return []
        }
    }

    private static applyQueryLocal<T>(items: T[], options: FindManyOptions<T>): T[] {
        if (!options.where && !options.orderBy && options.limit === undefined) {
            return items
        }

        let result = [...items]

        // where（支持点路径）
        if (options.where) {
            result = result.filter(item => this.matchesWhere(item, options.where as any))
        }

        // orderBy
        if (options.orderBy) {
            const orderByArray = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]
            result.sort((a, b) => {
                for (const { field, direction } of orderByArray) {
                    const aVal = (a as any)[field]
                    const bVal = (b as any)[field]
                    if (aVal !== bVal) {
                        const cmp = aVal < bVal ? -1 : 1
                        return direction === 'asc' ? cmp : -cmp
                    }
                }
                return 0
            })
        }

        // limit
        const end = options.limit ? options.limit : result.length
        return result.slice(0, end)
    }

    private static matchesWhere(item: any, where: Record<string, any>): boolean {
        return Object.entries(where).every(([key, condition]) => {
            const value = typeof key === 'string' && key.includes('.')
                ? getValueByPath(item, key)
                : item[key]

            if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
                if ('in' in condition && Array.isArray(condition.in)) {
                    return condition.in.some((v: any) => v === value)
                }
                if ('gt' in condition && !(value > condition.gt)) return false
                if ('gte' in condition && !(value >= condition.gte)) return false
                if ('lt' in condition && !(value < condition.lt)) return false
                if ('lte' in condition && !(value <= condition.lte)) return false
                if ('startsWith' in condition && typeof value === 'string' && !value.startsWith(condition.startsWith)) return false
                if ('endsWith' in condition && typeof value === 'string' && !value.endsWith(condition.endsWith)) return false
                if ('contains' in condition && typeof value === 'string' && !value.includes(condition.contains)) return false
                return true
            }

            return value === condition
        })
    }

    private static hydrateResults<T extends Entity>(
        results: T[],
        relName: string,
        config: Exclude<RelationConfig<T, any>, VariantsConfig<T>>,
        itemToKeyMap: Map<StoreKey, StoreKey | StoreKey[]>,
        bucket: Map<string, any[]>
    ): void {
        results.forEach(item => {
            const sourceKeyValue = itemToKeyMap.get(item.id)
            if (sourceKeyValue === undefined) {
                (item as any)[relName] = this.getDefaultValue(config)
                return
            }

            if (config.type === 'hasMany') {
                const keys = (Array.isArray(sourceKeyValue) ? sourceKeyValue : [sourceKeyValue]) as StoreKey[]
                const matched: any[] = []
                for (const k of keys) {
                    const found = bucket.get(normalizeKey(k)) as any[] | undefined
                    if (found) matched.push(...found)
                }
                (item as any)[relName] = matched
            } else {
                const key = Array.isArray(sourceKeyValue) ? sourceKeyValue[0] : sourceKeyValue
                const found = bucket.get(normalizeKey(key)) as any[] | undefined
                (item as any)[relName] = found ? found[0] : null
            }
        })
    }

    private static mergeQueryOptions(
        base?: FindManyOptions<any>,
        override?: FindManyOptions<any>
    ): FindManyOptions<any> {
        if (!base && !override) return {}
        if (!base) return { ...override, offset: undefined, cursor: undefined }
        if (!override) return { ...base, offset: undefined, cursor: undefined }

        return {
            where: deepMergeWhere(base.where, override.where),
            orderBy: override.orderBy !== undefined ? override.orderBy : base.orderBy,
            limit: override.limit !== undefined ? override.limit : base.limit,
            include: override.include !== undefined ? override.include : base.include,
            skipStore: override.skipStore !== undefined ? override.skipStore : base.skipStore
        }
    }

    private static getTargetKeyField(
        config: Exclude<RelationConfig<any, any>, VariantsConfig<any>>
    ): string {
        return config.type === 'belongsTo'
            ? (config.primaryKey as string) || 'id'
            : config.foreignKey
    }

    private static getRelationCacheKey(
        store: IStore<any>,
        relName: string,
        targetKeyField: string,
        where?: FindManyOptions<any>['where']
    ): string | undefined {
        // 仅在 where 为空或仅包含目标字段的 in 条件时启用缓存，避免跨过滤器复用导致结果错误
        if (where && typeof where === 'object') {
            const keys = Object.keys(where as any)
            if (keys.length !== 1 || keys[0] !== targetKeyField) return undefined
            const cond = (where as any)[targetKeyField]
            if (!cond || typeof cond !== 'object' || Array.isArray(cond) || !Array.isArray((cond as any).in)) return undefined
        } else if (where) {
            return undefined
        }
        const storeName = (store as any).name || 'store'
        return `${storeName}:${relName}:${targetKeyField}`
    }

    private static validateIncludeOptions(relName: string, options?: FindManyOptions<any>) {
        if (!options) return
        if ((options as any).offset !== undefined || (options as any).cursor !== undefined) {
            throw new Error(`include.${relName} 不支持 offset/cursor；请使用子 store 的 useFindMany 进行分页`)
        }
    }

    private static getDefaultValue(config?: RelationConfig<any, any>): any {
        if (!config) return null
        if (config.type === 'hasMany') return []
        return null
    }
}
