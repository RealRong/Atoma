import type { Entity, PartialWithId, StoreChange } from 'atoma-types/core'
import type { Runtime } from 'atoma-types/runtime'
import type { IntentInput, IntentInputByAction, WritePlanPolicy } from '../types'
import { prepareCreateInput, prepareUpdateInput, prepareUpsertInput, resolveWriteBase } from '../utils/prepareWriteInput'

export type IntentToChangesResult<T extends Entity> = Readonly<{
    changes: ReadonlyArray<StoreChange<T>>
    output?: T
    policy?: WritePlanPolicy
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

export async function adaptIntentToChanges<T extends Entity>(
    runtime: Runtime,
    input: IntentInput<T>
): Promise<IntentToChangesResult<T>> {
    const { handle, context } = input.scope
    if (input.action === 'create') {
        const prepared = await prepareCreateInput(runtime, handle, input.item, context)
        return {
            changes: [{ id: prepared.id, after: prepared as T }],
            output: prepared as T,
            policy: { action: 'create' }
        }
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
        )

        return {
            changes: [{ id: input.id, before: base as T, after: prepared as T }],
            output: prepared as T,
            policy: { action: 'update' }
        }
    }

    if (input.action === 'upsert') {
        const { base, prepared } = await resolveUpsertPreparedValue(runtime, input)
        const change = base
            ? { id: prepared.id, before: base as T, after: prepared as T }
            : { id: prepared.id, after: prepared as T }

        return {
            changes: [change],
            output: prepared as T,
            policy: {
                action: 'upsert',
                conflict: input.options?.conflict ?? 'cas',
                apply: input.options?.apply ?? 'merge'
            }
        }
    }

    const base = await resolveWriteBase(
        runtime,
        handle,
        input.id,
        input.options,
        context
    )
    return input.options?.force
        ? {
            changes: [{ id: input.id, before: base as T }],
            policy: { action: 'delete' }
        }
        : {
            changes: [{
                id: input.id,
                before: base as T,
                after: {
                    ...base,
                    deleted: true,
                    deletedAt: runtime.now()
                } as unknown as T
            }],
            policy: { action: 'update' }
        }
}
