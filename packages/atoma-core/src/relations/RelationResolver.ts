import type {
    Entity,
    FilterExpr,
    IStore,
    Query,
    RelationMap
} from 'atoma-types/core'
import {
    buildRelationPlan,
    type IncludeInput,
    type PlannedRelation,
    type StandardRelationConfig
} from './planner'

export interface ResolveBatchOptions {
    onError?: 'skip' | 'throw' | 'partial'
    timeout?: number
    maxConcurrency?: number
}

type RelationOptionsCarrier = {
    options?: Query<unknown>
}

function getRelationOptions<T extends Entity>(relation: StandardRelationConfig<T>): Query<unknown> | undefined {
    return (relation as RelationOptionsCarrier).options
}

export class RelationResolver {
    /**
     * 兼容旧入口：不再做 join/回填，仅用于触发 prefetch。
     * - 注意：返回值不包含关系字段
     */
    static async resolveBatch<T extends Entity>(
        items: T[],
        include: IncludeInput,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: string) => IStore<unknown> | undefined,
        options: ResolveBatchOptions = {}
    ): Promise<T[]> {
        await this.prefetchBatch(items, include, relations, resolveStore, options)
        return items
    }

    static async prefetchBatch<T extends Entity>(
        items: T[],
        include: IncludeInput,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: string) => IStore<unknown> | undefined,
        options: ResolveBatchOptions = {}
    ): Promise<void> {
        if (!items.length || !include || !relations) return

        const { onError = 'partial', timeout = 5000, maxConcurrency = 10 } = options
        const plan = buildRelationPlan(items, include, relations)
        const concurrencyLimit = this.normalizeConcurrency(maxConcurrency)

        await this.runWithConcurrency(plan, concurrencyLimit, async (entry) => {
            const controller = new AbortController()
            try {
                await this.withTimeout(
                    this.prefetchPlannedRelation(entry, resolveStore, controller.signal),
                    timeout,
                    controller,
                    entry.relationName
                )
            } catch (error) {
                if (onError === 'throw') throw error
                console.warn(`[Atoma Relations] "${entry.relationName}" prefetch failed:`, error)
                if (onError === 'skip') return
            }
        })
    }

    private static async prefetchPlannedRelation<T extends Entity>(
        entry: PlannedRelation<T>,
        resolveStore: (name: string) => IStore<unknown> | undefined,
        signal: AbortSignal
    ): Promise<void> {
        if (signal.aborted) return

        const userQuery = typeof entry.includeValue === 'object' ? entry.includeValue : undefined
        this.validateIncludeQuery(entry.relationName, userQuery)
        this.validateIncludeQuery(entry.relationName, getRelationOptions(entry.relation))

        if (!entry.uniqueKeys.length) return

        const store = resolveStore(entry.store)
        if (!store) {
            console.warn(`[Atoma Relations] Store not found: "${entry.store}" in relation "${entry.relationName}"`)
            return
        }

        const shouldUseIdLookup = entry.relationType === 'belongsTo'
            && entry.targetKeyField === 'id'
            && entry.mergedQuery.include === undefined
            && entry.mergedQuery.filter === undefined

        if (shouldUseIdLookup && typeof store.getMany === 'function') {
            if (signal.aborted) return
            await store.getMany(entry.uniqueKeys, true)
            return
        }

        const keyFilter: FilterExpr = {
            op: 'in',
            field: entry.targetKeyField,
            values: entry.uniqueKeys
        }
        const filter: FilterExpr = entry.mergedQuery.filter
            ? { op: 'and', args: [entry.mergedQuery.filter, keyFilter] }
            : keyFilter

        const query: Query<unknown> = {
            ...entry.mergedQuery,
            filter,
            page: undefined
        }

        if (signal.aborted) return
        await store.query?.(query)
    }

    private static validateIncludeQuery(relName: string, query?: Query<unknown>) {
        if (!query) return

        const page = query.page
        if (page === undefined) return

        if (!page || typeof page !== 'object' || Array.isArray(page)) {
            throw new Error(`include.${relName}.page 必须是对象，且仅支持 { limit?: number }`)
        }

        const pageRecord = page as Record<string, unknown>
        const keys = Object.keys(pageRecord).filter(key => pageRecord[key] !== undefined)
        const hasUnsupportedKey = keys.some(key => key !== 'limit')
        if (hasUnsupportedKey) {
            throw new Error(`include.${relName}.page 仅支持 limit，不支持 mode/offset/cursor`)
        }

        const limit = pageRecord.limit
        if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) {
            throw new Error(`include.${relName}.page.limit 必须是 >= 0 的有限数字`)
        }
    }

    private static normalizeConcurrency(limit: number): number {
        if (!Number.isFinite(limit)) return 1
        return Math.max(1, Math.floor(limit))
    }

    private static async withTimeout<T>(
        task: Promise<T>,
        timeoutMs: number,
        controller: AbortController,
        relName: string
    ): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutTask = new Promise<T>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort()
                reject(new Error(`Relation "${relName}" timeout`))
            }, timeoutMs)
        })

        try {
            return await Promise.race([task, timeoutTask])
        } finally {
            if (timer !== undefined) clearTimeout(timer)
        }
    }

    private static async runWithConcurrency<T>(
        tasks: T[],
        limit: number,
        runner: (task: T) => Promise<void>
    ): Promise<void> {
        if (!tasks.length) return

        const queue = tasks.slice()
        const workerCount = Math.min(limit, queue.length)
        const workers = Array.from({ length: workerCount }, async () => {
            while (queue.length > 0) {
                const next = queue.shift()
                if (!next) return
                await runner(next)
            }
        })

        await Promise.all(workers)
    }
}
