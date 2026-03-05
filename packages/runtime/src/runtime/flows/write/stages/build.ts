import { toChange } from '@atoma-js/core/store'
import { createIdempotencyKey } from '@atoma-js/shared'
import type {
    Entity,
    PartialWithId
} from '@atoma-js/types/core'
import type { Runtime } from '@atoma-js/types/runtime'
import type { WriteScope } from '../contracts'
import type { WriteCtx } from '../context'

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
    return {
        idempotencyKey: createIdempotencyKey({ now }),
        clientTimeMs: now()
    }
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
