import type { Entity, PartialWithId } from 'atoma-types/core'
import type { Runtime } from 'atoma-types/runtime'
import { createIdempotencyKey, ensureWriteItemMeta, resolvePositiveVersion } from 'atoma-shared'
import { toChange } from 'atoma-core/store'
import type { IntentInput, IntentInputByAction, PreparedWrite, PreparedWrites } from '../types'
import { prepareCreateInput, prepareUpdateInput, prepareUpsertInput, resolveWriteBase } from '../utils/prepareWriteInput'

function requireEntityObject<T extends Entity>(value: unknown, id: string): T {
    if (!value || typeof value !== 'object') {
        throw new Error('[Atoma] update: updater must return entity object')
    }

    if ((value as PartialWithId<T>).id !== id) {
        throw new Error(`[Atoma] update: updater must keep id unchanged (id=${String(id)})`)
    }

    return value as T
}

async function resolveUpsertPreparedValue<T extends Entity>(
    runtime: Runtime,
    input: IntentInputByAction<T, 'upsert'>,
    current?: PartialWithId<T>
): Promise<PartialWithId<T>> {
    const { handle, context } = input.scope

    if (current && (input.options?.apply ?? 'merge') === 'merge') {
        return await prepareUpdateInput(
            runtime,
            handle,
            current,
            input.item,
            context
        )
    }

    return await prepareUpsertInput(
        runtime,
        handle,
        input.item,
        context
    )
}

async function requireOutbound<T extends Entity>({
    runtime,
    input,
    value
}: {
    runtime: Runtime
    input: IntentInput<T>
    value: T
}): Promise<T> {
    const outbound = await runtime.transform.outbound(
        input.scope.handle,
        value,
        input.scope.context
    )
    if (outbound === undefined) {
        throw new Error('[Atoma] transform returned empty for outbound write')
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

function ensureUniqueIds<T extends Entity>(prepared: PreparedWrites<T>) {
    const seen = new Set<string>()
    prepared.forEach((item, index) => {
        const id = String(item.entry.item.id ?? '').trim()
        if (!id) return
        if (seen.has(id)) {
            throw new Error(`[Atoma] writeMany: duplicate item id in batch (id=${id}, index=${index})`)
        }
        seen.add(id)
    })
}

async function prepareLocalWrite<T extends Entity>(
    runtime: Runtime,
    input: IntentInput<T>
): Promise<PreparedWrite<T>> {
    const { handle, context } = input.scope
    const snapshot = handle.state.snapshot()
    const now = runtime.now

    switch (input.action) {
        case 'create': {
            const prepared = await prepareCreateInput(runtime, handle, input.item, context) as T
            const outbound = await requireOutbound({
                runtime,
                input,
                value: prepared
            })
            const id = prepared.id
            const current = snapshot.get(id)
            const meta = createMeta(now)

            return {
                entry: {
                    action: 'create',
                    item: {
                        id,
                        value: outbound,
                        meta
                    }
                },
                optimistic: toChange({
                    id,
                    before: current,
                    after: prepared
                }),
                output: prepared
            }
        }
        case 'update': {
            const base = await resolveWriteBase(
                runtime,
                handle,
                input.id,
                input.options,
                context
            )
            const next = requireEntityObject(input.updater(base as Readonly<T>), input.id)
            const prepared = await prepareUpdateInput(
                runtime,
                handle,
                base,
                next as PartialWithId<T>,
                context
            ) as T
            const outbound = await requireOutbound({
                runtime,
                input,
                value: prepared
            })
            const id = input.id
            const current = snapshot.get(id)
            const baseVersion = resolvePositiveVersion(base as T | undefined)
            const meta = createMeta(now)

            return {
                entry: {
                    action: 'update',
                    item: {
                        id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: outbound,
                        meta
                    }
                },
                optimistic: toChange({
                    id,
                    before: current,
                    after: prepared
                }),
                output: prepared
            }
        }
        case 'upsert': {
            const current = snapshot.get(input.item.id)
            const prepared = await resolveUpsertPreparedValue(
                runtime,
                input,
                current as PartialWithId<T> | undefined
            )
            const normalized = prepared as T
            const outbound = await requireOutbound({
                runtime,
                input,
                value: normalized
            })
            const id = prepared.id
            const conflict = input.options?.conflict ?? 'cas'
            const apply = input.options?.apply ?? 'merge'
            const meta = createMeta(now)

            return {
                entry: {
                    action: 'upsert',
                    item: {
                        id,
                        value: outbound,
                        meta
                    },
                    options: {
                        upsert: {
                            conflict,
                            apply
                        }
                    }
                },
                optimistic: toChange({
                    id,
                    before: current,
                    after: normalized
                }),
                output: normalized
            }
        }
        case 'delete': {
            const base = await resolveWriteBase(
                runtime,
                handle,
                input.id,
                input.options,
                context
            )
            const id = input.id
            const current = snapshot.get(id)
            const meta = createMeta(now)

            if (input.options?.force) {
                const previous = current ?? (base as T)
                const baseVersion = resolvePositiveVersion(previous)
                return {
                    entry: {
                        action: 'delete',
                        item: {
                            id,
                            ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                            meta
                        }
                    },
                    optimistic: toChange({
                        id,
                        before: previous
                    })
                }
            }

            const after = {
                ...base,
                deleted: true,
                deletedAt: runtime.now()
            } as unknown as T
            const baseVersion = resolvePositiveVersion(base as T | undefined)
            const outbound = await requireOutbound({
                runtime,
                input,
                value: after
            })

            return {
                entry: {
                    action: 'update',
                    item: {
                        id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: outbound,
                        meta
                    }
                },
                optimistic: toChange({
                    id,
                    before: current,
                    after
                })
            }
        }
    }
}

export async function prepareLocalWrites<T extends Entity>(
    runtime: Runtime,
    inputs: ReadonlyArray<IntentInput<T>>
): Promise<PreparedWrites<T>> {
    const prepared = await Promise.all(inputs.map(input => prepareLocalWrite(runtime, input)))
    ensureUniqueIds(prepared)
    return prepared
}
