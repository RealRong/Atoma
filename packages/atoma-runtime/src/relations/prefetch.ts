import {
    buildRelationPlan,
    type IncludeInput,
    type PlannedRelation,
    type StandardRelationConfig
} from 'atoma-core/relations'
import type { Entity, FilterExpr, Store, Query, RelationMap, StoreToken } from 'atoma-types/core'
import type { RelationPrefetchOptions } from 'atoma-types/runtime'

type RelationOptionsCarrier = {
    options?: Query<unknown>
}

function getRelationOptions<T extends Entity>(relation: StandardRelationConfig<T>): Query<unknown> | undefined {
    return (relation as RelationOptionsCarrier).options
}

export async function prefetchRelations<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined,
    resolveStore: (name: StoreToken) => Store<unknown> | undefined,
    options: RelationPrefetchOptions = {}
): Promise<void> {
    if (!items.length || !include || !relations) return

    const { onError = 'partial', timeout = 5000, maxConcurrency = 10 } = options
    const plan = buildRelationPlan(items, include, relations)
    const concurrencyLimit = normalizeConcurrency(maxConcurrency ?? 10)

    await runWithConcurrency(plan, concurrencyLimit, async (entry) => {
        const controller = new AbortController()
        try {
            await withTimeout(
                prefetchPlanEntry(entry, resolveStore, controller.signal),
                timeout ?? 5000,
                controller,
                entry.relationName
            )
        } catch (error) {
            if (onError === 'throw') throw error
            if (onError === 'partial') {
                console.warn(`[Atoma Relations] "${entry.relationName}" prefetch failed:`, error)
            }
        }
    })
}

async function prefetchPlanEntry<T extends Entity>(
    entry: PlannedRelation<T>,
    resolveStore: (name: StoreToken) => Store<unknown> | undefined,
    signal: AbortSignal
): Promise<void> {
    if (signal.aborted) return

    const userQuery = typeof entry.includeValue === 'object' ? entry.includeValue : undefined
    validateIncludeQuery(entry.relationName, userQuery)
    validateIncludeQuery(entry.relationName, getRelationOptions(entry.relation))

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

function validateIncludeQuery(relName: string, query?: Query<unknown>) {
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

function normalizeConcurrency(limit: number): number {
    if (!Number.isFinite(limit)) return 1
    return Math.max(1, Math.floor(limit))
}

async function withTimeout<T>(
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

async function runWithConcurrency<T>(
    tasks: T[],
    limit: number,
    runner: (task: T) => Promise<void>
): Promise<void> {
    if (!tasks.length) return

    let index = 0
    const workerCount = Math.min(limit, tasks.length)
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const taskIndex = index
            index += 1
            if (taskIndex >= tasks.length) return
            await runner(tasks[taskIndex])
        }
    })

    await Promise.all(workers)
}
