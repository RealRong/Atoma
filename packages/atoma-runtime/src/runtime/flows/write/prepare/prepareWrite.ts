import type { Entity, PartialWithId } from 'atoma-types/core'
import type { Runtime } from 'atoma-types/runtime'
import { createIdempotencyKey, ensureWriteItemMeta, requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
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
): Promise<{ base?: PartialWithId<T>; prepared: PartialWithId<T> }> {
    const { handle, context } = input.scope
    const base = current

    if (base && (input.options?.apply ?? 'merge') === 'merge') {
        return {
            base,
            prepared: await prepareUpdateInput(
                runtime,
                handle,
                base,
                input.item,
                context
            )
        }
    }

    return {
        base,
        prepared: await prepareUpsertInput(
            runtime,
            handle,
            input.item,
            context
        )
    }
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

async function prepareWrite<T extends Entity>(
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
            const meta = createMeta(now)

            return {
                entry: {
                    action: 'update',
                    item: {
                        id,
                        baseVersion: requireBaseVersion(id, base),
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
            const { base, prepared } = await resolveUpsertPreparedValue(
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
            const expectedVersion = conflict === 'cas'
                ? resolvePositiveVersion(current ?? (base as T | undefined))
                : undefined
            const meta = createMeta(now)

            return {
                entry: {
                    action: 'upsert',
                    item: {
                        id,
                        ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
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
                return {
                    entry: {
                        action: 'delete',
                        item: {
                            id,
                            baseVersion: requireBaseVersion(id, previous),
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
                        baseVersion: requireBaseVersion(id, base),
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

export async function prepareWrites<T extends Entity>(
    runtime: Runtime,
    inputs: ReadonlyArray<IntentInput<T>>
): Promise<PreparedWrites<T>> {
    return await Promise.all(inputs.map(input => prepareWrite(runtime, input)))
}
