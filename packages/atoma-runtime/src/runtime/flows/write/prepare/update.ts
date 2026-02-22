import type { Entity, ActionContext, PartialWithId } from 'atoma-types/core'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'
import { toChange } from 'atoma-core/store'
import type { WriteScope, IntentCommandByAction, PreparedWrite } from '../contracts'
import { requireOutbound, createMeta, requireProcessed, resolveWriteBase, requireUpdatedEntity } from './utils'

export async function prepareUpdateInput<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    base: PartialWithId<T>,
    patch: PartialWithId<T>,
    context?: ActionContext
): Promise<PartialWithId<T>> {
    const mergedInput = runtime.engine.mutation.merge(base, patch)
    const processed = await runtime.processor.inbound(handle, mergedInput as T, context)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareUpdateInput')
}

export async function prepareUpdate<T extends Entity>(
    runtime: Runtime,
    scope: WriteScope<T>,
    intent: IntentCommandByAction<T, 'update'>
): Promise<PreparedWrite<T>> {
    const { handle, context } = scope
    const snapshot = handle.state.snapshot()
    const now = runtime.now

    const base = await resolveWriteBase(
        runtime,
        handle,
        intent.id,
        intent.options,
        context
    )
    const next = requireUpdatedEntity(intent.updater(base as Readonly<T>), intent.id)
    const prepared = await prepareUpdateInput(
        runtime,
        handle,
        base,
        next as PartialWithId<T>,
        context
    ) as T
    const outbound = await requireOutbound({
        runtime,
        scope,
        value: prepared
    })
    const id = intent.id
    const current = snapshot.get(id)
    const meta = createMeta(now)

    return {
        entry: {
            action: 'update',
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
