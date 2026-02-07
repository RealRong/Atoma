import {
    Entity,
    IStore,
    Query,
    RelationMap
} from 'atoma-types/core'
import { buildRelationPlan, type PlannedRelation } from './planner'

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
        const plan = buildRelationPlan(items, include, relations)

        await this.runWithConcurrency(plan, maxConcurrency, async (entry) => {
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
        resolveStore: (name: string) => IStore<any> | undefined,
        signal: AbortSignal
    ): Promise<void> {
        if (signal.aborted) return

        const userQuery = typeof entry.includeValue === 'object' ? entry.includeValue : {}
        this.validateIncludeQuery(entry.relationName, userQuery)
        this.validateIncludeQuery(entry.relationName, (entry.relation as any).options)

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

        const keyFilter = { op: 'in', field: entry.targetKeyField, values: entry.uniqueKeys } as any
        const filter = entry.mergedQuery.filter
            ? ({ op: 'and', args: [entry.mergedQuery.filter, keyFilter] } as any)
            : keyFilter

        const query: Query<any> = {
            ...entry.mergedQuery,
            filter,
            // include 不支持分页：强制清空 page
            page: undefined
        }

        if (signal.aborted) return
        await store.query?.(query)
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
