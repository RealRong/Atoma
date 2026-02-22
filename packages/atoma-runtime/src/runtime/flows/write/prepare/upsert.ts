import type { Entity, ActionContext, PartialWithId } from 'atoma-types/core'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'
import { toChange } from 'atoma-core/store'
import type { WriteScope, IntentCommandByAction, PreparedWrite } from '../contracts'
import { requireOutbound, createMeta, requireProcessed } from './utils'
import { prepareUpdateInput } from './update'

export async function prepareUpsertInput<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    item: PartialWithId<T>,
    context?: ActionContext
): Promise<PartialWithId<T>> {
    const candidate = {
        ...(item as Record<string, unknown>),
        id: item.id
    } as PartialWithId<T>
    const processed = await runtime.processor.inbound(handle, candidate as T, context)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareUpsertInput')
}

export async function resolveUpsertInput<T extends Entity>({
    runtime,
    scope,
    intent,
    current
}: {
    runtime: Runtime
    scope: WriteScope<T>
    intent: IntentCommandByAction<T, 'upsert'>
    current?: PartialWithId<T>
}): Promise<PartialWithId<T>> {
    const { handle, context } = scope

    if (current && (intent.options?.apply ?? 'merge') === 'merge') {
        return await prepareUpdateInput(
            runtime,
            handle,
            current,
            intent.item,
            context
        )
    }

    return await prepareUpsertInput(
        runtime,
        handle,
        intent.item,
        context
    )
}

export async function prepareUpsert<T extends Entity>(
    runtime: Runtime,
    scope: WriteScope<T>,
    intent: IntentCommandByAction<T, 'upsert'>
): Promise<PreparedWrite<T>> {
    const { handle } = scope
    const snapshot = handle.state.snapshot()
    const now = runtime.now

    const current = snapshot.get(intent.item.id)
    const prepared = await resolveUpsertInput({
        runtime,
        scope,
        intent,
        current: current as PartialWithId<T> | undefined
    })
    const normalized = prepared as T
    const outbound = await requireOutbound({
        runtime,
        scope,
        value: normalized
    })
    const id = prepared.id
    const conflict = intent.options?.conflict ?? 'cas'
    const apply = intent.options?.apply ?? 'merge'
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
