import type { Entity, ActionContext, PartialWithId } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'
import { toChange } from 'atoma-core/store'
import type { WriteScope, IntentCommandByAction, PreparedWrite } from '../contracts'
import { requireOutbound, createMeta, requireProcessed } from './utils'

function ensureCreateItemId<T extends Entity>(handle: StoreHandle<T>, item: Partial<T>): PartialWithId<T> {
    const base = item as Partial<T> & { id?: EntityId }
    const id = (typeof base.id === 'string' && base.id.length > 0)
        ? base.id
        : handle.id()

    return {
        ...item,
        id
    } as PartialWithId<T>
}

async function prepareCreateInput<T extends Entity>(
    runtime: Runtime,
    handle: StoreHandle<T>,
    item: Partial<T>,
    context?: ActionContext
): Promise<PartialWithId<T>> {
    const initialized = ensureCreateItemId(handle, item)
    const processed = await runtime.processor.inbound(handle, initialized as T, context)
    return requireProcessed(processed as PartialWithId<T> | undefined, 'prepareCreateInput')
}

export async function prepareCreate<T extends Entity>(
    runtime: Runtime,
    scope: WriteScope<T>,
    intent: IntentCommandByAction<T, 'create'>
): Promise<PreparedWrite<T>> {
    const { handle, context } = scope
    const snapshot = handle.state.snapshot()
    const now = runtime.now

    const prepared = await prepareCreateInput(runtime, handle, intent.item, context) as T
    const outbound = await requireOutbound({
        runtime,
        scope,
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
