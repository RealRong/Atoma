import type * as Types from 'atoma-types/core'
import { Store } from 'atoma-core'
import type { EntityId } from 'atoma-types/protocol'
import type { TranslatedWriteOp } from 'atoma-types/runtime'
import type { StoreHandle } from 'atoma-types/runtime'
import type { CoreRuntime } from 'atoma-types/runtime'
import type { Store as StoreTypes } from 'atoma-core'
import { entityId as entityIdUtils, immer as immerUtils, version } from 'atoma-shared'
import type { Patch } from 'immer'
import { buildWriteItem, buildWriteItemMeta, buildWriteOperation, buildWriteOptions } from './opsBuilder'

export async function buildWriteOps<T extends Types.Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    event: StoreTypes.WriteEvent<T>
    optimisticState: Map<EntityId, T>
    opContext: Types.OperationContext
}): Promise<TranslatedWriteOp[]> {
    const { runtime, handle, event, optimisticState, opContext } = args
    const intents = event.type === 'patches'
        ? await buildWriteIntentsFromPatches({
            optimisticState,
            patches: event.patches,
            inversePatches: event.inversePatches,
            prepareValue: async (value, ctx) => runtime.transform.outbound(handle, value, ctx),
            opContext
        })
        : await Store.buildWriteIntents({
            event,
            optimisticState,
            opContext,
            prepareValue: async (value, ctx) => {
                return await runtime.transform.outbound(handle, value, ctx)
            }
        })

    return intents.map(intent => {
        const meta = buildWriteItemMeta({ now: runtime.now })
        const item = buildWriteItem(intent, meta)
        const op = buildWriteOperation({
            opId: handle.nextOpId('w'),
            resource: handle.storeName,
            action: intent.action,
            items: [item],
            ...(intent.options ? { options: buildWriteOptions(intent.options) } : {})
        })
        return {
            op,
            action: intent.action,
            ...(intent.entityId ? { entityId: intent.entityId } : {}),
            ...(intent.intent ? { intent: intent.intent } : {})
        }
    })
}

async function buildWriteIntentsFromPatches<T extends Types.Entity>(args: {
    optimisticState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
    prepareValue: (value: T, ctx?: Types.OperationContext) => Promise<T | undefined>
    opContext?: Types.OperationContext
}): Promise<Types.WriteIntent<T>[]> {
    const touchedIds = new Set<EntityId>()
    args.patches.forEach(p => {
        const root = p.path?.[0]
        if (entityIdUtils.isEntityId(root)) touchedIds.add(root as EntityId)
    })

    const inverseRootAdds = immerUtils.collectInverseRootAddsByEntityId(args.inversePatches)
    const baseVersionByDeletedId = new Map<EntityId, number>()
    inverseRootAdds.forEach((value, id) => {
        baseVersionByDeletedId.set(id, version.requireBaseVersion(id, value))
    })

    const intents: Types.WriteIntent<T>[] = []
    for (const id of touchedIds.values()) {
        const next = args.optimisticState.get(id)
        if (next) {
            const baseVersion = version.resolvePositiveVersion(next)
            const outbound = await args.prepareValue(next, args.opContext)
            if (outbound === undefined) {
                throw new Error('[Atoma] transform returned empty for outbound write')
            }
            intents.push({
                action: 'upsert',
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: outbound,
                options: { merge: false, upsert: { mode: 'loose' } }
            })
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }
        intents.push({ action: 'delete', entityId: id, baseVersion })
    }

    return intents
}
