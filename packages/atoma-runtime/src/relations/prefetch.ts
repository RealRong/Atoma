import {
    buildRelationPlan,
    type IncludeInput,
    type RelationPlanEntry
} from 'atoma-core/relations'
import type { Entity, FilterExpr, Query, RelationMap, StoreToken } from 'atoma-types/core'
import type { RelationPrefetchOptions, RelationStore } from 'atoma-types/runtime'

export async function prefetchRelations<T extends Entity>(
    items: T[],
    include: IncludeInput,
    relations: RelationMap<T> | undefined,
    resolveStore: (name: StoreToken) => RelationStore | undefined,
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
    entry: RelationPlanEntry<T>,
    resolveStore: (name: StoreToken) => RelationStore | undefined,
    signal: AbortSignal
): Promise<void> {
    if (signal.aborted) return

    if (!entry.uniqueKeys.length) return

    const store = resolveStore(entry.store)
    if (!store) {
        console.warn(`[Atoma Relations] Store not found: "${entry.store}" in relation "${entry.relationName}"`)
        return
    }

    const shouldUseIdLookup = entry.relationType === 'belongsTo'
        && entry.targetKeyField === 'id'
        && entry.query.filter === undefined

    if (shouldUseIdLookup && typeof store.getMany === 'function') {
        if (signal.aborted) return
        await store.getMany(entry.uniqueKeys)
        return
    }

    const keyFilter: FilterExpr = {
        op: 'in',
        field: entry.targetKeyField,
        values: entry.uniqueKeys
    }
    const filter: FilterExpr = entry.query.filter
        ? { op: 'and', args: [entry.query.filter, keyFilter] }
        : keyFilter

    const query: Query<unknown> = {
        filter,
        ...(entry.query.sort ? { sort: entry.query.sort } : {})
    }

    if (signal.aborted) return
    await store.query(query)
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
