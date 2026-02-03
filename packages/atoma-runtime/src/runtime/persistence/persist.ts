import type * as Types from 'atoma-types/core'
import { Store } from 'atoma-core'
import type { EntityId, Operation, WriteAction, WriteItem, WriteItemMeta, WriteOptions } from 'atoma-types/protocol'
import type { TranslatedWriteOp } from 'atoma-types/runtime'
import type { StoreHandle } from 'atoma-types/runtime'
import type { CoreRuntime } from 'atoma-types/runtime'
import type { Store as StoreTypes } from 'atoma-core'
import { Protocol } from 'atoma-protocol'

export async function buildWriteOps<T extends Types.Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    event: StoreTypes.WriteEvent<T>
    optimisticState: Map<EntityId, T>
    opContext: Types.OperationContext
}): Promise<TranslatedWriteOp[]> {
    const { runtime, handle, event, optimisticState, opContext } = args
    const specs = await Store.buildWriteOpSpecs({
        event,
        optimisticState,
        opContext,
        metaForItem: () => buildWriteItemMeta({ now: runtime.now }),
        prepareValue: async (value, ctx) => {
            return await runtime.transform.outbound(handle, value, ctx)
        }
    })

    return specs.map(spec => {
        const op = buildWriteOperation({
            opId: handle.nextOpId('w'),
            resource: handle.storeName,
            action: spec.action,
            items: [spec.item],
            ...(spec.options ? { options: spec.options } : {})
        })
        return {
            op,
            action: spec.action,
            ...(spec.entityId ? { entityId: spec.entityId } : {}),
            ...(spec.intent ? { intent: spec.intent } : {})
        }
    })
}

function buildWriteOperation(args: {
    opId: string
    resource: string
    action: WriteAction
    items: WriteItem[]
    options?: WriteOptions
}): Operation {
    return Protocol.ops.build.buildWriteOp({
        opId: args.opId,
        write: {
            resource: args.resource,
            action: args.action,
            items: args.items,
            ...(args.options ? { options: args.options } : {})
        }
    })
}

function buildWriteItemMeta(args: { now: () => number }): WriteItemMeta {
    const meta: WriteItemMeta = {
        idempotencyKey: Protocol.ids.createIdempotencyKey({ now: args.now }),
        clientTimeMs: args.now()
    }

    return Protocol.ops.meta.ensureWriteItemMeta({
        meta,
        now: args.now
    })
}
