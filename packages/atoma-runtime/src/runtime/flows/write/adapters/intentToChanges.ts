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

async function resolveUpsertPreparedValue<T extends Entity>(args: {
    runtime: Runtime
    input: IntentInputByAction<T, 'upsert'>
}): Promise<{ base?: PartialWithId<T>; prepared: PartialWithId<T> }> {
    const id = args.input.item.id
    const base = args.input.handle.state.getSnapshot().get(id) as PartialWithId<T> | undefined
    if (!base) {
        return {
            prepared: await prepareCreateInput(
                args.runtime,
                args.input.handle,
                args.input.item as Partial<T>,
                args.input.context
            )
        }
    }

    if (args.input.options?.merge !== false) {
        return {
            base,
            prepared: await prepareUpdateInput(
                args.runtime,
                args.input.handle,
                base,
                args.input.item,
                args.input.context
            )
        }
    }

    const now = args.runtime.now()
    const candidate = ({
        ...(args.input.item as Record<string, unknown>),
        id,
        createdAt: (base as Record<string, unknown>).createdAt ?? now,
        updatedAt: now,
        version: (args.input.item as Record<string, unknown>).version ?? (base as Record<string, unknown>).version
    } as unknown) as PartialWithId<T>
    const processed = await args.runtime.transform.inbound(args.input.handle, candidate as T, args.input.context)
    if (!processed) {
        throw new Error('[Atoma] upsert: transform returned empty')
    }

    return {
        base,
        prepared: processed as PartialWithId<T>
    }
}

export async function adaptIntentToChanges<T extends Entity>(args: {
    runtime: Runtime
    input: IntentInput<T>
}): Promise<IntentToChangesResult<T>> {
    if (args.input.action === 'create') {
        const prepared = await prepareCreateInput(args.runtime, args.input.handle, args.input.item, args.input.context)
        return {
            changes: [{ id: prepared.id, after: prepared as T }],
            output: prepared as T,
            policy: { action: 'create' }
        }
    }

    if (args.input.action === 'update') {
        const base = await resolveWriteBase(
            args.runtime,
            args.input.handle,
            args.input.id,
            args.input.options,
            args.input.context
        )
        const next = requireEntityObject(args.input.updater(base as Readonly<T>), args.input.id)
        const prepared = await prepareUpdateInput(
            args.runtime,
            args.input.handle,
            base,
            next as PartialWithId<T>,
            args.input.context
        )

        return {
            changes: [{ id: args.input.id, before: base as T, after: prepared as T }],
            output: prepared as T,
            policy: { action: 'update' }
        }
    }

    if (args.input.action === 'upsert') {
        const { base, prepared } = await resolveUpsertPreparedValue({
            runtime: args.runtime,
            input: args.input
        })

        return {
            changes: [{
                id: prepared.id,
                ...(base ? { before: base as T } : {}),
                after: prepared as T
            }],
            output: prepared as T,
            policy: {
                action: 'upsert',
                merge: args.input.options?.merge,
                upsertMode: args.input.options?.mode
            }
        }
    }

    const base = await resolveWriteBase(
        args.runtime,
        args.input.handle,
        args.input.id,
        args.input.options,
        args.input.context
    )
    return args.input.options?.force
        ? {
            changes: [{ id: args.input.id, before: base as T }],
            policy: { action: 'delete' }
        }
        : {
            changes: [{
                id: args.input.id,
                before: base as T,
                after: {
                    ...base,
                    deleted: true,
                    deletedAt: args.runtime.now()
                } as unknown as T
            }],
            policy: { action: 'update' }
        }
}
