import { invertChanges, mergeChanges, toChange } from 'atoma-core/store'
import { createIdempotencyKey, ensureWriteItemMeta } from 'atoma-shared'
import type {
    Entity,
    PartialWithId,
    StoreChange,
    WriteManyItemErr,
    WriteManyResult
} from 'atoma-types/core'
import type {
    Runtime,
    WriteEntry,
    WriteItemResult,
    WriteOutput
} from 'atoma-types/runtime'
import type {
    IntentCommand,
    WriteScope,
} from './contracts'

export type Row<T extends Entity> = {
    intent: IntentCommand<T>
    intentId?: string
    base?: T
    change?: StoreChange<T>
    entry?: WriteEntry
    optimistic?: StoreChange<T>
}

export type WriteCtx<T extends Entity> = {
    runtime: Runtime
    scope: WriteScope<T>
    rows: Row<T>[]
    optimisticChanges: ReadonlyArray<StoreChange<T>>
    status: WriteOutput['status']
    results: WriteManyResult<T | void>
    changes: ReadonlyArray<StoreChange<T>>
}

function toIntentId<T extends Entity>(intent: IntentCommand<T>): string | undefined {
    if (intent.action === 'create') {
        const maybeId = (intent.item as { id?: unknown }).id
        return typeof maybeId === 'string' && maybeId.length > 0 ? maybeId : undefined
    }
    if (intent.action === 'upsert') {
        return String(intent.item.id)
    }
    return String(intent.id)
}

function ensureEntry<T extends Entity>(row: Row<T>, index: number): WriteEntry {
    if (!row.entry) {
        throw new Error(`[Atoma] write: missing write entry at index=${index}`)
    }
    return row.entry
}

function ensureChange<T extends Entity>(row: Row<T>, index: number): StoreChange<T> {
    if (!row.change) {
        throw new Error(`[Atoma] write: missing change at index=${index}`)
    }
    return row.change
}

function ensureOutput<T extends Entity>(row: Row<T>, index: number): T | void {
    if (row.intent.action === 'delete') return
    const change = ensureChange(row, index)
    if (change.after === undefined) {
        throw new Error(`[Atoma] write: missing output at index=${index}`)
    }
    return change.after
}

function shouldApplyReturnedData(entry: WriteEntry): boolean {
    if (entry.options?.returning === false) return false
    const select = entry.options?.select
    return !(select && Object.keys(select).length > 0)
}

function ensureWriteResultStatus(writeResult: WriteOutput, expectedCount: number) {
    if (writeResult.results.length !== expectedCount) {
        throw new Error(`[Atoma] execution.write result count mismatch (expected=${expectedCount} actual=${writeResult.results.length})`)
    }
}

function toWriteItemError(
    action: WriteEntry['action'],
    result: WriteItemResult
): Error {
    if (result.ok) return new Error(`[Atoma] write(${action}) failed`)
    const msg = result.error.message || 'Write failed'
    const error = new Error(`[Atoma] write(${action}) failed: ${msg}`)
        ; (error as { error?: unknown }).error = result.error
    return error
}

function toWriteManyError(
    entry: WriteEntry,
    result: Extract<WriteItemResult, { ok: false }>,
    index: number
): WriteManyItemErr {
    const current = result.current
    return {
        index,
        ok: false,
        error: toWriteItemError(entry.action, result),
        ...(current
            ? {
                current: {
                    ...(current.value !== undefined ? { value: current.value } : {})
                }
            }
            : {})
    }
}

function ensureCreateItemId<T extends Entity>(scope: WriteScope<T>, item: Partial<T>): T {
    const base = item as Partial<T> & { id?: unknown }
    const id = (typeof base.id === 'string' && base.id.length > 0)
        ? base.id
        : scope.handle.id()
    return {
        ...(item as Record<string, unknown>),
        id
    } as T
}

async function requireOutbound<T extends Entity>({
    runtime,
    scope,
    value
}: {
    runtime: Runtime
    scope: WriteScope<T>
    value: T
}): Promise<T> {
    const outbound = await runtime.processor.outbound(
        scope.handle,
        value,
        scope.context
    )
    if (outbound === undefined) {
        throw new Error('[Atoma] processor returned empty for outbound write')
    }
    return outbound
}

function createMeta(now: () => number) {
    return ensureWriteItemMeta({
        meta: {
            idempotencyKey: createIdempotencyKey({ now }),
            clientTimeMs: now()
        },
        now
    })
}

function requireUpdatedEntity<T extends Entity>(value: unknown, id: string): PartialWithId<T> {
    if (!value || typeof value !== 'object') {
        throw new Error('[Atoma] update: updater must return entity object')
    }
    if ((value as PartialWithId<T>).id !== id) {
        throw new Error(`[Atoma] update: updater must keep id unchanged (id=${String(id)})`)
    }
    return value as PartialWithId<T>
}

function requireProcessed<T>(value: T | undefined, tag: string): T {
    if (value === undefined) {
        throw new Error(`[Atoma] ${tag}: processor returned empty`)
    }
    return value
}

async function mergeInbound<T extends Entity>({
    runtime,
    scope,
    base,
    patch,
    tag
}: {
    runtime: Runtime
    scope: WriteScope<T>
    base: PartialWithId<T>
    patch: PartialWithId<T>
    tag: string
}): Promise<T> {
    const merged = runtime.engine.mutation.merge(base, patch)
    const processed = await runtime.processor.inbound(
        scope.handle,
        merged as T,
        scope.context
    )
    return requireProcessed(processed as T | undefined, tag)
}

export function createContext<T extends Entity>(args: {
    runtime: Runtime
    scope: WriteScope<T>
}): WriteCtx<T> {
    return {
        ...args,
        rows: [],
        optimisticChanges: [],
        status: 'confirmed',
        results: [],
        changes: []
    }
}

export function preflight<T extends Entity>(ctx: WriteCtx<T>, intents: ReadonlyArray<IntentCommand<T>>) {
    const seenIds = new Set<string>()
    const rows: Row<T>[] = []

    intents.forEach((intent, index) => {
        const id = toIntentId(intent)
        if (id) {
            if (seenIds.has(id)) {
                throw new Error(`[Atoma] writeMany: duplicate item id in batch (id=${id}, index=${index})`)
            }
            seenIds.add(id)
        }
        rows.push({
            intent,
            intentId: id
        })
    })

    ctx.rows = rows
}

export async function hydrate<T extends Entity>(ctx: WriteCtx<T>) {
    const { runtime, scope, rows } = ctx
    const snapshot = scope.handle.state.snapshot()
    const missing = new Set<string>()

    rows.forEach(row => {
        const intent = row.intent
        if (intent.action !== 'update' && intent.action !== 'delete') return

        const cached = snapshot.get(intent.id)
        if (cached) {
            row.base = cached
            return
        }
        missing.add(intent.id)
    })

    if (!missing.size) return

    const consistency = runtime.execution.getConsistency()
    if (consistency.base !== 'fetch') {
        const id = Array.from(missing)[0]
        throw new Error(`[Atoma] write: 缓存缺失且当前写入模式禁止补读，请先 fetch 再写入（id=${String(id)}）`)
    }
    if (!runtime.execution.hasExecutor('query')) {
        const id = Array.from(missing)[0]
        throw new Error(`[Atoma] write: 缓存缺失且未安装远端 query 执行器（id=${String(id)}）`)
    }

    const fetched = await runtime.stores.use<T>(scope.handle.storeName).hydrate(
        Array.from(missing),
        {
            signal: scope.signal,
            context: scope.context,
            mode: 'missing'
        }
    )

    rows.forEach(row => {
        const intent = row.intent
        if (intent.action !== 'update' && intent.action !== 'delete') return
        if (row.base) return

        const base = fetched.get(intent.id)
        if (!base) {
            throw new Error(`Item with id ${intent.id} not found`)
        }
        row.base = base
    })
}

export async function build<T extends Entity>(ctx: WriteCtx<T>) {
    const { runtime, scope, rows } = ctx
    const snapshot = scope.handle.state.snapshot()
    const hasRemoteWrite = runtime.execution.hasExecutor('write')

    for (const [index, row] of rows.entries()) {
        const intent = row.intent

        switch (intent.action) {
            case 'create': {
                const initialized = ensureCreateItemId(scope, intent.item)
                const inbound = await runtime.processor.inbound(scope.handle, initialized, scope.context)
                const prepared = requireProcessed(inbound as T | undefined, 'buildCreate')
                const outbound = hasRemoteWrite
                    ? await requireOutbound({ runtime, scope, value: prepared })
                    : prepared
                const id = prepared.id
                const current = snapshot.get(id)
                const meta = hasRemoteWrite ? createMeta(runtime.now) : undefined

                row.change = toChange({
                    id,
                    before: current,
                    after: prepared
                })
                row.entry = {
                    action: 'create',
                    item: meta
                        ? {
                            id,
                            value: outbound,
                            meta
                        }
                        : {
                            id,
                            value: outbound
                        }
                }
                break
            }
            case 'update': {
                const base = row.base
                if (!base) {
                    throw new Error(`[Atoma] write: missing update base at index=${index}`)
                }
                const next = requireUpdatedEntity<T>(intent.updater(base as Readonly<T>), intent.id)
                const prepared = await mergeInbound({
                    runtime,
                    scope,
                    base: base as PartialWithId<T>,
                    patch: next,
                    tag: 'buildUpdate'
                })
                const outbound = hasRemoteWrite
                    ? await requireOutbound({ runtime, scope, value: prepared })
                    : prepared
                const current = snapshot.get(intent.id)
                const meta = hasRemoteWrite ? createMeta(runtime.now) : undefined

                row.change = toChange({
                    id: intent.id,
                    before: current,
                    after: prepared
                })
                row.entry = {
                    action: 'update',
                    item: meta
                        ? {
                            id: intent.id,
                            value: outbound,
                            meta
                        }
                        : {
                            id: intent.id,
                            value: outbound
                        }
                }
                break
            }
            case 'upsert': {
                const current = snapshot.get(intent.item.id)
                const apply = intent.options?.apply ?? 'merge'
                const prepared = current && apply === 'merge'
                    ? await mergeInbound({
                        runtime,
                        scope,
                        base: current as PartialWithId<T>,
                        patch: intent.item,
                        tag: 'buildUpsert'
                    })
                    : requireProcessed(
                        await runtime.processor.inbound(
                            scope.handle,
                            {
                                ...(intent.item as Record<string, unknown>),
                                id: intent.item.id
                            } as T,
                            scope.context
                        ) as T | undefined,
                        'buildUpsert'
                    )
                const outbound = hasRemoteWrite
                    ? await requireOutbound({
                        runtime,
                        scope,
                        value: prepared
                    })
                    : prepared
                const conflict = intent.options?.conflict ?? 'cas'
                const meta = hasRemoteWrite ? createMeta(runtime.now) : undefined

                row.change = toChange({
                    id: intent.item.id,
                    before: current,
                    after: prepared
                })
                row.entry = {
                    action: 'upsert',
                    item: meta
                        ? {
                            id: intent.item.id,
                            value: outbound,
                            meta
                        }
                        : {
                            id: intent.item.id,
                            value: outbound
                        },
                    options: {
                        upsert: {
                            conflict,
                            apply
                        }
                    }
                }
                break
            }
            case 'delete': {
                const current = snapshot.get(intent.id)
                const base = row.base
                if (!base) {
                    throw new Error(`[Atoma] write: missing delete base at index=${index}`)
                }

                if (intent.options?.force) {
                    const meta = hasRemoteWrite ? createMeta(runtime.now) : undefined
                    row.change = toChange({
                        id: intent.id,
                        before: current ?? base
                    })
                    row.entry = {
                        action: 'delete',
                        item: meta
                            ? {
                                id: intent.id,
                                meta
                            }
                            : {
                                id: intent.id
                            }
                    }
                    break
                }

                const after = {
                    ...base,
                    deleted: true,
                    deletedAt: runtime.now()
                } as unknown as T
                const outbound = hasRemoteWrite
                    ? await requireOutbound({
                        runtime,
                        scope,
                        value: after
                    })
                    : after
                const meta = hasRemoteWrite ? createMeta(runtime.now) : undefined

                row.change = toChange({
                    id: intent.id,
                    before: current,
                    after
                })
                row.entry = {
                    action: 'update',
                    item: meta
                        ? {
                            id: intent.id,
                            value: outbound,
                            meta
                        }
                        : {
                            id: intent.id,
                            value: outbound
                        }
                }
                break
            }
        }
    }
}

export async function commit<T extends Entity>(ctx: WriteCtx<T>) {
    const { runtime, scope, rows } = ctx
    const consistency = runtime.execution.getConsistency()
    const optimistic = consistency.commit === 'optimistic'

    if (optimistic) {
        const allChanges = rows.map((row, index) => ensureChange(row, index))
        const needDuplicateCheck = rows.some((row) => row.intentId === undefined)
        const hasDuplicateId = needDuplicateCheck
            ? (() => {
                const seenIds = new Set<string>()
                return allChanges.some((change) => {
                    const id = String(change.id)
                    if (seenIds.has(id)) return true
                    seenIds.add(id)
                    return false
                })
            })()
            : false

        if (!hasDuplicateId) {
            const applied = scope.handle.state.apply(allChanges)
            const byId = new Map<string, StoreChange<T>>()
            applied.forEach((change) => {
                byId.set(String(change.id), change)
            })
            rows.forEach((row, index) => {
                row.optimistic = byId.get(String(allChanges[index].id))
            })
            ctx.optimisticChanges = applied
        } else {
            const single: StoreChange<T>[] = []
            const optimisticChanges: StoreChange<T>[] = []
            rows.forEach((row, index) => {
                const change = ensureChange(row, index)
                single[0] = change
                const applied = scope.handle.state.apply(single)[0]
                row.optimistic = applied
                if (applied) {
                    optimisticChanges.push(applied)
                }
            })
            ctx.optimisticChanges = mergeChanges(optimisticChanges)
        }
    }

    if (!runtime.execution.hasExecutor('write')) {
        ctx.status = 'confirmed'
        return undefined
    }

    const entries = rows.map((row, index) => ensureEntry(row, index))
    const writeResult = await runtime.execution.write(
        {
            handle: scope.handle,
            context: scope.context,
            entries
        },
        scope.signal ? { signal: scope.signal } : undefined
    )
    ensureWriteResultStatus(writeResult, entries.length)
    ctx.status = writeResult.status
    return writeResult.results
}

export async function reconcileEmit<T extends Entity>(
    ctx: WriteCtx<T>,
    remoteResults?: ReadonlyArray<WriteItemResult>
) {
    const { runtime, scope, rows } = ctx
    const consistency = runtime.execution.getConsistency()
    const optimistic = consistency.commit === 'optimistic'
    const hasRemote = remoteResults !== undefined

    if (!hasRemote) {
        ctx.results = rows.map((row, index) => ({
            index,
            ok: true,
            value: ensureOutput(row, index)
        }))
        ctx.changes = optimistic
            ? ctx.optimisticChanges
            : scope.handle.state.apply(rows.map((row, index) => ensureChange(row, index)))
        ctx.status = 'confirmed'
        return
    }

    const results: WriteManyResult<T | void> = new Array(rows.length)
    const retainedOptimistic: StoreChange<T>[] = []
    const rollbackChanges: StoreChange<T>[] = []
    const reconcileRows: number[] = []
    const reconcileItems: unknown[] = []

    for (const [index, row] of rows.entries()) {
        const entry = ensureEntry(row, index)
        const remoteResult = remoteResults[index]
        if (!remoteResult) {
            throw new Error(`[Atoma] execution.write missing write item result at index=${index}`)
        }

        if (!remoteResult.ok) {
            results[index] = toWriteManyError(entry, remoteResult, index)
            if (row.optimistic) {
                rollbackChanges.push(row.optimistic)
            }
            continue
        }

        let value: T | void = ensureOutput(row, index)
        if (shouldApplyReturnedData(entry) && remoteResult.data && typeof remoteResult.data === 'object') {
            reconcileRows.push(index)
            reconcileItems.push(remoteResult.data)
        }

        results[index] = {
            index,
            ok: true,
            value
        } as Extract<WriteManyResult<T | void>[0], { ok: true }>
        if (row.optimistic) {
            retainedOptimistic.push(row.optimistic)
        }
    }

    if (rollbackChanges.length) {
        scope.handle.state.apply(invertChanges(rollbackChanges))
    }

    const reconcile = reconcileItems.length
        ? await runtime.stores.use<T>(scope.handle.storeName).reconcile(
            {
                mode: 'upsert',
                items: reconcileItems
            },
            {
                context: scope.context
            }
        )
        : {
            changes: [],
            items: [],
            results: []
        }
    for (let index = 0; index < reconcileRows.length; index += 1) {
        const normalized = reconcile.results[index]
        if (normalized === undefined) continue
        const rowIndex = reconcileRows[index]
        const current = results[rowIndex]
        if (!current || !current.ok) continue
        current.value = normalized
    }

    ctx.results = results
    if (!retainedOptimistic.length) {
        ctx.changes = reconcile.changes
    } else if (!reconcile.changes.length) {
        ctx.changes = mergeChanges(retainedOptimistic)
    } else {
        ctx.changes = mergeChanges(retainedOptimistic, reconcile.changes)
    }
    if (!optimistic && ctx.status === 'confirmed' && !reconcile.changes.length) {
        ctx.changes = []
    }
}
