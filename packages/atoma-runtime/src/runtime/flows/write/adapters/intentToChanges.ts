import type { Entity, PartialWithId, StoreChange } from 'atoma-types/core'
import type { Runtime } from 'atoma-types/runtime'
import type { IntentInput, IntentInputByAction, WritePlanPolicy } from '../types'
import { prepareCreateInput, prepareUpdateInput, resolveWriteBase } from '../utils/prepareWriteInput'

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
    const id = input.item.id
    const base = input.handle.state.getSnapshot().get(id) as PartialWithId<T> | undefined
    if (!base) {
        return {
            prepared: await prepareCreateInput(
                runtime,
                input.handle,
                input.item as Partial<T>,
                input.context
            )
        }
    }

    if (input.options?.merge !== false) {
        return {
            base,
            prepared: await prepareUpdateInput(
                runtime,
                input.handle,
                base,
                input.item,
                input.context
            )
        }
    }

    const now = runtime.now()
    const candidate = ({
        ...(input.item as Record<string, unknown>),
        id,
        createdAt: (base as Record<string, unknown>).createdAt ?? now,
        updatedAt: now,
        version: (input.item as Record<string, unknown>).version ?? (base as Record<string, unknown>).version
    } as unknown) as PartialWithId<T>
    const processed = await runtime.transform.inbound(input.handle, candidate as T, input.context)
    if (!processed) {
        throw new Error('[Atoma] upsert: transform returned empty')
    }

    return {
        base,
        prepared: processed as PartialWithId<T>
    }
}

export async function adaptIntentToChanges<T extends Entity>(
    runtime: Runtime,
    input: IntentInput<T>
): Promise<IntentToChangesResult<T>> {
    if (input.action === 'create') {
        const prepared = await prepareCreateInput(runtime, input.handle, input.item, input.context)
        return {
            changes: [{ id: prepared.id, after: prepared as T }],
            output: prepared as T,
            policy: { action: 'create' }
        }
    }

    if (input.action === 'update') {
        const base = await resolveWriteBase(
            runtime,
            input.handle,
            input.id,
            input.options,
            input.context
        )
        const next = requireEntityObject(input.updater(base as Readonly<T>), input.id)
        const prepared = await prepareUpdateInput(
            runtime,
            input.handle,
            base,
            next as PartialWithId<T>,
            input.context
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
                merge: input.options?.merge,
                upsertMode: input.options?.mode
            }
        }
    }

    const base = await resolveWriteBase(
        runtime,
        input.handle,
        input.id,
        input.options,
        input.context
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
