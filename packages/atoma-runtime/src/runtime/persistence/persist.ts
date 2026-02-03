import type * as Types from 'atoma-types/core'
import { Store } from 'atoma-core'
import type { EntityId } from 'atoma-types/protocol'
import type { TranslatedWriteOp } from 'atoma-types/runtime'
import type { StoreHandle } from 'atoma-types/runtime'
import type { CoreRuntime } from 'atoma-types/runtime'
import type { Store as StoreTypes } from 'atoma-core'

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
        metaForItem: () => Store.buildWriteItemMeta({ now: runtime.now }),
        prepareValue: async (value, ctx) => {
            return await runtime.transform.outbound(handle, value, ctx)
        }
    })

    return specs.map(spec => {
        const op = Store.buildWriteOperation({
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