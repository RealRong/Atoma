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
    base?: T
    change?: StoreChange<T>
    output?: T
    entry?: WriteEntry
    remoteResult?: WriteItemResult
    optimistic?: ReadonlyArray<StoreChange<T>>
}

export type WriteCtx<T extends Entity> = {
    runtime: Runtime
    scope: WriteScope<T>
    rows: Row<T>[]
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
    if (row.output === undefined) {
        throw new Error(`[Atoma] write: missing output at index=${index}`)
    }
    return row.output
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
            intent
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

    for (const [index, row] of rows.entries()) {
        const intent = row.intent
        const meta = createMeta(runtime.now)

        switch (intent.action) {
            case 'create': {
                const initialized = ensureCreateItemId(scope, intent.item)
                const inbound = await runtime.processor.inbound(scope.handle, initialized, scope.context)
                const prepared = requireProcessed(inbound as T | undefined, 'buildCreate')
                const outbound = await requireOutbound({ runtime, scope, value: prepared })
                const id = prepared.id
                const current = snapshot.get(id)

                row.change = toChange({
                    id,
                    before: current,
                    after: prepared
                })
                row.output = prepared
                row.entry = {
                    action: 'create',
                    item: {
                        id,
                        value: outbound,
                        meta
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
                const outbound = await requireOutbound({ runtime, scope, value: prepared })
                const current = snapshot.get(intent.id)

                row.change = toChange({
                    id: intent.id,
                    before: current,
                    after: prepared
                })
                row.output = prepared
                row.entry = {
                    action: 'update',
                    item: {
                        id: intent.id,
                        value: outbound,
                        meta
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
                const outbound = await requireOutbound({
                    runtime,
                    scope,
                    value: prepared
                })
                const conflict = intent.options?.conflict ?? 'cas'

                row.change = toChange({
                    id: intent.item.id,
                    before: current,
                    after: prepared
                })
                row.output = prepared
                row.entry = {
                    action: 'upsert',
                    item: {
                        id: intent.item.id,
                        value: outbound,
                        meta
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
                    row.change = toChange({
                        id: intent.id,
                        before: current ?? base
                    })
                    row.entry = {
                        action: 'delete',
                        item: {
                            id: intent.id,
                            meta
                        }
                    }
                    break
                }

                const after = {
                    ...base,
                    deleted: true,
                    deletedAt: runtime.now()
                } as unknown as T
                const outbound = await requireOutbound({
                    runtime,
                    scope,
                    value: after
                })

                row.change = toChange({
                    id: intent.id,
                    before: current,
                    after
                })
                row.entry = {
                    action: 'update',
                    item: {
                        id: intent.id,
                        value: outbound,
                        meta
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
        const single: StoreChange<T>[] = []
        rows.forEach((row, index) => {
            const change = ensureChange(row, index)
            single[0] = change
            row.optimistic = scope.handle.state.apply(single)
        })
    }

    if (!runtime.execution.hasExecutor('write')) {
        ctx.status = 'confirmed'
        return
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

    rows.forEach((row, index) => {
        row.remoteResult = writeResult.results[index]
    })
    ctx.status = writeResult.status
}

export async function reconcileEmit<T extends Entity>(ctx: WriteCtx<T>) {
    const { runtime, scope, rows } = ctx
    const consistency = runtime.execution.getConsistency()
    const optimistic = consistency.commit === 'optimistic'
    const hasRemote = runtime.execution.hasExecutor('write')

    if (!hasRemote) {
        const localChanges = optimistic
            ? mergeChanges(...rows.map(row => row.optimistic ?? []))
            : scope.handle.state.apply(rows.map((row, index) => ensureChange(row, index)))

        ctx.results = rows.map((row, index) => ({
            index,
            ok: true,
            value: ensureOutput(row, index)
        }))
        ctx.changes = localChanges
        ctx.status = 'confirmed'
        return
    }

    const results: WriteManyResult<T | void> = new Array(rows.length)
    const retainedOptimistic: StoreChange<T>[] = []
    const rollbackChanges: StoreChange<T>[] = []
    const pendingReconcile: Array<{
        rowIndex: number
        inputIndex: number
    }> = []
    const reconcileItems: unknown[] = []

    for (const [index, row] of rows.entries()) {
        const entry = ensureEntry(row, index)
        const remoteResult = row.remoteResult
        if (!remoteResult) {
            throw new Error(`[Atoma] execution.write missing write item result at index=${index}`)
        }

        if (!remoteResult.ok) {
            results[index] = toWriteManyError(entry, remoteResult, index)
            if (row.optimistic?.length) {
                rollbackChanges.push(...row.optimistic)
            }
            continue
        }

        let value: T | void = ensureOutput(row, index)
        if (shouldApplyReturnedData(entry) && remoteResult.data && typeof remoteResult.data === 'object') {
            pendingReconcile.push({
                rowIndex: index,
                inputIndex: reconcileItems.length
            })
            reconcileItems.push(remoteResult.data)
        }

        results[index] = {
            index,
            ok: true,
            value
        } as Extract<WriteManyResult<T | void>[0], { ok: true }>
        if (row.optimistic?.length) {
            retainedOptimistic.push(...row.optimistic)
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
    pendingReconcile.forEach(({ rowIndex, inputIndex }) => {
        const normalized = reconcile.results[inputIndex]
        if (normalized === undefined) return
        const current = results[rowIndex]
        if (!current || !current.ok) return
        current.value = normalized
    })

    ctx.results = results
    ctx.changes = mergeChanges(retainedOptimistic, reconcile.changes)
    if (!optimistic && ctx.status === 'confirmed' && !reconcile.changes.length) {
        ctx.changes = []
    }
}
