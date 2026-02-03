import {
    Entity,
    IStore,
    Query,
    RelationConfig,
    RelationMap,
    VariantsConfig
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { getValueByPath } from './utils'

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
        include: Record<string, boolean | Query<any>> | undefined,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: string) => IStore<any> | undefined,
        options: ResolveBatchOptions = {}
    ): Promise<T[]> {
        await this.prefetchBatch(items, include, relations, resolveStore, options)
        return items
    }

    static async prefetchBatch<T extends Entity>(
        items: T[],
        include: Record<string, boolean | Query<any>> | undefined,
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
        relOpts: boolean | Query<any>,
        config: RelationConfig<T, any>,
        resolveStore: (name: string) => IStore<any> | undefined,
        signal: AbortSignal
    ): Promise<void> {
        if (signal.aborted) return

        const userQuery = typeof relOpts === 'object' ? relOpts : {}
        this.validateIncludeQuery(relName, userQuery)
        if (config.type !== 'variants') {
            this.validateIncludeQuery(relName, (config as any).options)
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
        relOpts: boolean | Query<any>,
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
        relOpts: boolean | Query<any>,
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

        const mergedQuery = this.mergeQuery((config as any).options, typeof relOpts === 'object' ? relOpts : undefined)
        const targetKeyField = this.getTargetKeyField(config)

        const shouldUseIdLookup = config.type === 'belongsTo'
            && targetKeyField === 'id'
            && mergedQuery.include === undefined
            && mergedQuery.filter === undefined

        if (shouldUseIdLookup && typeof store.getMany === 'function') {
            if (signal.aborted) return
            await store.getMany(uniqueKeys, true)
            return
        }

        const keyFilter = { op: 'in', field: targetKeyField, values: uniqueKeys } as any
        const filter = mergedQuery.filter
            ? ({ op: 'and', args: [mergedQuery.filter, keyFilter] } as any)
            : keyFilter

        const query: Query<any> = {
            ...mergedQuery,
            filter,
            // include 不支持分页：强制清空 page
            page: undefined
        }

        if (signal.aborted) return
        await store.query?.(query)
    }

    private static collectKeys<T extends Entity>(
        items: T[],
        config: Exclude<RelationConfig<T, any>, VariantsConfig<T>>
    ): EntityId[] {
        const rawKeys = new Set<EntityId>()

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

    private static extractKeyValue<T>(item: T, selector: string | ((item: T) => any)): EntityId | EntityId[] | undefined | null {
        if (typeof selector === 'function') return selector(item)
        if (typeof selector === 'string') {
            return getValueByPath(item, selector)
        }
        return undefined
    }

    private static mergeQuery(base?: Query<any>, override?: Query<any>): Query<any> {
        if (!base && !override) return {}
        if (!base) return { ...override, page: undefined }
        if (!override) return { ...base, page: undefined }

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

    private static getTargetKeyField(
        config: Exclude<RelationConfig<any, any>, VariantsConfig<any>>
    ): string {
        return config.type === 'belongsTo'
            ? (config.primaryKey as string) || 'id'
            : config.foreignKey
    }

    private static validateIncludeQuery(relName: string, query?: Query<any>) {
        if (!query) return
        if ((query as any).page !== undefined) {
            throw new Error(`include.${relName} 不支持分页（page）；请使用子 store 的 query 进行分页`)
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
            clearTimeout(timer)
        }
    }

    private static async runWithConcurrency<T>(
        tasks: T[],
        limit: number,
        runner: (task: T) => Promise<void>
    ): Promise<void> {
        const queue = tasks.slice()
        const running: Promise<void>[] = []

        const runNext = async () => {
            const next = queue.shift()
            if (!next) return
            await runner(next)
            await runNext()
        }

        const count = Math.min(limit, queue.length)
        for (let i = 0; i < count; i++) {
            running.push(runNext())
        }

        await Promise.all(running)
    }
}