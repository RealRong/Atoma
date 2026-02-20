import type { Entity, PartialWithId, StoreChange } from 'atoma-types/core'
import type { Runtime, WriteEntry } from 'atoma-types/runtime'
import { createIdempotencyKey, ensureWriteItemMeta, requireBaseVersion, resolvePositiveVersion } from 'atoma-shared'
import { toChange } from 'atoma-core/store'
import type { IntentInput, IntentInputByAction, WritePlan } from '../types'
import { prepareCreateInput, prepareUpdateInput, prepareUpsertInput, resolveWriteBase } from '../utils/prepareWriteInput'

export type IntentToPlanResult<T extends Entity> = Readonly<{
    plan: WritePlan<T>
    output?: T
}>

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
    input: IntentInputByAction<T, 'upsert'>
): Promise<{ base?: PartialWithId<T>; prepared: PartialWithId<T> }> {
    const { handle, context } = input.scope
    const id = input.item.id
    const base = handle.state.snapshot().get(id) as PartialWithId<T> | undefined

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

function toOptimisticChange<T extends Entity>({
    id,
    before,
    after
}: {
    id: string
    before?: T
    after?: T
}): StoreChange<T> {
    return toChange({ id, before, after })
}

export async function compileIntentToPlan<T extends Entity>(
    runtime: Runtime,
    input: IntentInput<T>
): Promise<IntentToPlanResult<T>> {
    const { handle, context } = input.scope
    const snapshot = handle.state.snapshot()
    const entries: WriteEntry[] = []
    const optimisticChanges: StoreChange<T>[] = []
    const createEntryId = input.scope.createEntryId
    const now = runtime.now

    if (input.action === 'create') {
        const prepared = await prepareCreateInput(runtime, handle, input.item, context) as T
        const outbound = await requireOutbound({
            runtime,
            input,
            value: prepared
        })
        const id = prepared.id
        const current = snapshot.get(id)

        entries.push({
            entryId: createEntryId(),
            action: 'create',
            item: {
                id,
                value: outbound,
                meta: createMeta(now)
            }
        })
        optimisticChanges.push(toOptimisticChange({
            id,
            before: current,
            after: prepared
        }))

        return { plan: { entries, optimisticChanges }, output: prepared }
    }

    if (input.action === 'update') {
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

        entries.push({
            entryId: createEntryId(),
            action: 'update',
            item: {
                id,
                baseVersion: requireBaseVersion(id, base),
                value: outbound,
                meta: createMeta(now)
            }
        })
        optimisticChanges.push(toOptimisticChange({
            id,
            before: current,
            after: prepared
        }))

        return { plan: { entries, optimisticChanges }, output: prepared }
    }

    if (input.action === 'upsert') {
        const { base, prepared } = await resolveUpsertPreparedValue(runtime, input)
        const normalized = prepared as T
        const outbound = await requireOutbound({
            runtime,
            input,
            value: normalized
        })
        const id = prepared.id
        const current = snapshot.get(id)
        const conflict = input.options?.conflict ?? 'cas'
        const apply = input.options?.apply ?? 'merge'
        const expectedVersion = conflict === 'cas'
            ? resolvePositiveVersion(current ?? (base as T | undefined))
            : undefined

        entries.push({
            entryId: createEntryId(),
            action: 'upsert',
            item: {
                id,
                ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
                value: outbound,
                meta: createMeta(now)
            },
            options: {
                upsert: {
                    conflict,
                    apply
                }
            }
        })
        optimisticChanges.push(toOptimisticChange({
            id,
            before: current,
            after: normalized
        }))

        return { plan: { entries, optimisticChanges }, output: normalized }
    }

    const base = await resolveWriteBase(
        runtime,
        handle,
        input.id,
        input.options,
        context
    )
    const id = input.id
    const current = snapshot.get(id)
    if (input.options?.force) {
        const previous = current ?? (base as T)
        return {
            plan: {
                entries: [{
                    entryId: createEntryId(),
                    action: 'delete',
                    item: {
                        id,
                        baseVersion: requireBaseVersion(id, previous),
                        meta: createMeta(now)
                    }
                }],
                optimisticChanges: [toOptimisticChange({
                    id,
                    before: previous
                })]
            }
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
        plan: {
            entries: [{
                entryId: createEntryId(),
                action: 'update',
                item: {
                    id,
                    baseVersion: requireBaseVersion(id, base),
                    value: outbound,
                    meta: createMeta(now)
                }
            }],
            optimisticChanges: [toOptimisticChange({
                id,
                before: current,
                after
            })]
        }
    }
}
