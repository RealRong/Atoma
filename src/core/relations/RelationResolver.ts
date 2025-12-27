import {
    Entity,
    FindManyOptions,
    IStore,
    RelationConfig,
    RelationMap,
    StoreKey,
    VariantsConfig
} from '../types'
import { deepMergeWhere, getValueByPath } from './utils'

export interface ResolveBatchOptions {
    onError?: 'skip' | 'throw' | 'partial'
    timeout?: number
    maxConcurrency?: number
}

export class RelationResolver {
    /**
     * 兼容旧入口：不再做 join/回填，仅用于触发 prefetch。
     * - 注意：返回值不包含关系字段
     */
    static async resolveBatch<T extends Entity>(
        items: T[],
        include: Record<string, boolean | FindManyOptions<any>> | undefined,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: string) => IStore<any> | undefined,
        options: ResolveBatchOptions = {}
    ): Promise<T[]> {
        await this.prefetchBatch(items, include, relations, resolveStore, options)
        return items
    }

    static async prefetchBatch<T extends Entity>(
        items: T[],
        include: Record<string, boolean | FindManyOptions<any>> | undefined,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: string) => IStore<any> | undefined,
        options: ResolveBatchOptions = {}
    ): Promise<void> {
        if (!items.length || !include || !relations) return

        const { onError = 'partial', timeout = 5000, maxConcurrency = 10 } = options
        const entries = Object.entries(include)

        await this.runWithConcurrency(entries, maxConcurrency, async ([relName, relOpts]) => {
            if (relOpts === false || relOpts === undefined || relOpts === null) return
            const config = relations[relName]
            if (!config) return

            const controller = new AbortController()
            try {
                await this.withTimeout(
                    this.prefetchSingleRelation(items, relName, relOpts, config, resolveStore, controller.signal),
                    timeout,
                    controller,
                    relName
                )
            } catch (error) {
                if (onError === 'throw') throw error
                console.warn(`[Atoma Relations] "${relName}" prefetch failed:`, error)
                if (onError === 'skip') return
            }
        })
    }

    private static async prefetchSingleRelation<T extends Entity>(
        items: T[],
        relName: string,
        relOpts: boolean | FindManyOptions<any>,
        config: RelationConfig<T, any>,
        resolveStore: (name: string) => IStore<any> | undefined,
        signal: AbortSignal
    ): Promise<void> {
        if (signal.aborted) return

        const userOptions = typeof relOpts === 'object' ? relOpts : {}
        this.validateIncludeOptions(relName, userOptions)
        if (config.type !== 'variants') {
            this.validateIncludeOptions(relName, (config as any).options)
        }

        if (config.type === 'variants') {
            await this.prefetchVariants(items, relName, relOpts, config, resolveStore, signal)
            return
        }

        await this.prefetchStandardRelation(items, relName, relOpts, config, resolveStore, signal)
    }

    private static async prefetchVariants<T extends Entity>(
        items: T[],
        relName: string,
        relOpts: boolean | FindManyOptions<any>,
        config: VariantsConfig<T>,
        resolveStore: (name: string) => IStore<any> | undefined,
        signal: AbortSignal
    ): Promise<void> {
        if (signal.aborted) return

        const branchGroups = new Map<number, T[]>()
        items.forEach(item => {
            const idx = config.branches.findIndex(b => b.when(item))
            if (idx < 0) return
            const group = branchGroups.get(idx) || []
            group.push(item)
            branchGroups.set(idx, group)
        })

        await Promise.all(
            Array.from(branchGroups.entries()).map(async ([idx, group]) => {
                const branch = config.branches[idx]
                await this.prefetchStandardRelation(group, relName, relOpts, branch.relation as any, resolveStore, signal)
            })
        )
    }

    private static async prefetchStandardRelation<T extends Entity>(
        items: T[],
        relName: string,
        relOpts: boolean | FindManyOptions<any>,
        config: Exclude<RelationConfig<T, any>, VariantsConfig<T>>,
        resolveStore: (name: string) => IStore<any> | undefined,
        signal: AbortSignal
    ): Promise<void> {
        if (signal.aborted) return

        const uniqueKeys = this.collectKeys(items, config)
        if (uniqueKeys.length === 0) return

        const store = resolveStore(config.store)
        if (!store) {
            console.warn(`[Atoma Relations] Store not found: "${config.store}" in relation "${relName}"`)
            return
        }

        const mergedOptions = this.mergeQueryOptions((config as any).options, typeof relOpts === 'object' ? relOpts : undefined)
        const targetKeyField = this.getTargetKeyField(config)

        const shouldUseIdLookup = config.type === 'belongsTo'
            && targetKeyField === 'id'
            && mergedOptions.include === undefined
            && mergedOptions.where === undefined

        if (shouldUseIdLookup && typeof store.getMultipleByIds === 'function') {
            if (signal.aborted) return
            await store.getMultipleByIds(uniqueKeys, true)
            return
        }

        const keySet = new Set(uniqueKeys)
        const inWhere = { [targetKeyField]: { in: uniqueKeys } } as any
        const where = typeof mergedOptions.where === 'function'
            ? ((item: any) => Boolean((mergedOptions.where as any)(item)) && keySet.has((item as any)?.[targetKeyField]))
            : deepMergeWhere(mergedOptions.where as any, inWhere)

        const query: FindManyOptions<any> = {
            ...mergedOptions,
            // prefetch-only：确保写入 store map，且避免 sparse fields 污染缓存
            skipStore: false,
            fields: undefined,
            // include 不支持分页：强制清空分页相关参数
            offset: undefined,
            after: undefined,
            before: undefined,
            cursor: undefined,
            // hasMany/hasOne 的 limit/orderBy 是“每个 parent 的 Top-N”语义，无法用单次 where-in 正确表达，prefetch 阶段不下推
            limit: undefined,
            orderBy: undefined,
            where
        }

        if (signal.aborted) return
        await store.findMany?.(query)
    }

    private static collectKeys<T extends Entity>(
        items: T[],
        config: Exclude<RelationConfig<T, any>, VariantsConfig<T>>
    ): StoreKey[] {
        const rawKeys = new Set<StoreKey>()

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
        })
        return Array.from(rawKeys)
    }

    private static extractKeyValue<T>(item: T, selector: string | ((item: T) => any)): StoreKey | StoreKey[] | undefined | null {
        if (typeof selector === 'function') return selector(item)
        if (typeof selector === 'string') {
            return getValueByPath(item, selector)
        }
        return undefined
    }

    private static mergeQueryOptions(
        base?: FindManyOptions<any>,
        override?: FindManyOptions<any>
    ): FindManyOptions<any> {
        if (!base && !override) return {}
        if (!base) return { ...override, offset: undefined, after: undefined, before: undefined, cursor: undefined }
        if (!override) return { ...base, offset: undefined, after: undefined, before: undefined, cursor: undefined }

        const where = (() => {
            const b: any = base.where
            const o: any = override.where
            if (typeof o === 'function') return o
            if (typeof b === 'function') return b
            return deepMergeWhere(b, o)
        })()

        return {
            where,
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

    private static validateIncludeOptions(relName: string, options?: FindManyOptions<any>) {
        if (!options) return
        const o: any = options
        if (o.offset !== undefined || o.after !== undefined || o.before !== undefined || o.cursor !== undefined) {
            throw new Error(`include.${relName} 不支持分页（offset/after/before/cursor）；请使用子 store 的 useFindMany 进行分页`)
        }
    }

    private static async withTimeout<T>(
        task: Promise<T>,
        timeoutMs: number,
        controller: AbortController,
        relName: string
    ): Promise<T> {
        let timer: any
        const timeoutTask = new Promise<T>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort()
                reject(new Error(`Relation "${relName}" timeout`))
            }, timeoutMs)
        })
        try {
            return await Promise.race([task, timeoutTask])
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    private static async runWithConcurrency<T>(
        items: T[],
        maxConcurrency: number,
        worker: (item: T) => Promise<void>
    ): Promise<void> {
        if (items.length === 0) return
        const concurrency = Math.max(1, Math.min(maxConcurrency, items.length))
        let index = 0

        await Promise.all(
            Array.from({ length: concurrency }).map(async () => {
                while (true) {
                    const current = index
                    index++
                    if (current >= items.length) return
                    await worker(items[current])
                }
            })
        )
    }
}
