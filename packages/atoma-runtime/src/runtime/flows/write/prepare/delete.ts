import type { Entity } from 'atoma-types/core'
import type { Runtime } from 'atoma-types/runtime'
import { toChange } from 'atoma-core/store'
import type { WriteScope, IntentCommandByAction, PreparedWrite } from '../contracts'
import { requireOutbound, createMeta, resolveWriteBase } from './utils'

export async function prepareDelete<T extends Entity>(
    runtime: Runtime,
    scope: WriteScope<T>,
    intent: IntentCommandByAction<T, 'delete'>
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
    const id = intent.id
    const current = snapshot.get(id)
    const meta = createMeta(now)

    if (intent.options?.force) {
        const previous = current ?? (base as T)
        return {
            entry: {
                action: 'delete',
                item: {
                    id,
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
        scope,
        value: after
    })

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
            after
        })
    }
}
