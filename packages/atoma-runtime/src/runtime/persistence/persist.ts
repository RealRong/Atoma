import type { Entity, OperationContext } from 'atoma-core'
import type { EntityId, WriteAction, WriteItem, WriteItemMeta, WriteOptions } from 'atoma-protocol'
import { Protocol } from 'atoma-protocol'
import { entityId as entityIdUtils, immer as immerUtils, version } from 'atoma-shared'
import type { Patch } from 'immer'
import type { TranslatedWriteOp } from '../../types/persistenceTypes'
import type { StoreHandle } from '../../types/runtimeTypes'
import type { CoreRuntime } from '../../types/runtimeTypes'
import type { WriteEvent } from '../write/types'

export async function buildWriteOps<T extends Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    event: WriteEvent<T>
    optimisticState: Map<EntityId, T>
    opContext: OperationContext
}): Promise<TranslatedWriteOp[]> {
    const { runtime, handle, event, optimisticState, opContext } = args
    const meta = buildWriteItemMeta(runtime)

    if (event.type === 'add') {
        const entityId = event.data.id as EntityId
        const value = optimisticState.get(entityId) ?? (event.data as T)
        const outbound = await ensureOutbound(runtime, handle, value as T, opContext)
        return [buildWriteOp(handle, 'create', { entityId, value: outbound, meta }, { intent: 'created' })]
    }

    if (event.type === 'update') {
        const entityId = event.data.id as EntityId
        const baseVersion = version.requireBaseVersion(entityId, event.base as any)
        const value = optimisticState.get(entityId) ?? (event.data as T)
        const outbound = await ensureOutbound(runtime, handle, value as T, opContext)
        return [buildWriteOp(handle, 'update', { entityId, baseVersion, value: outbound, meta })]
    }

    if (event.type === 'upsert') {
        const entityId = event.data.id as EntityId
        const value = optimisticState.get(entityId) ?? (event.data as T)
        const outbound = await ensureOutbound(runtime, handle, value as T, opContext)
        const baseVersion = version.resolvePositiveVersion(value as any)
        const options = buildUpsertOptions(event.upsert)
        return [buildWriteOp(handle, 'upsert', {
            entityId,
            ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
            value: outbound,
            meta
        }, options ? { options } : undefined)]
    }

    if (event.type === 'remove') {
        const entityId = event.data.id as EntityId
        const baseVersion = version.requireBaseVersion(entityId, event.base as any)
        const value = optimisticState.get(entityId)
        if (!value) return []
        const outbound = await ensureOutbound(runtime, handle, value as T, opContext)
        return [buildWriteOp(handle, 'update', { entityId, baseVersion, value: outbound, meta })]
    }

    if (event.type === 'forceRemove') {
        const entityId = event.data.id as EntityId
        const baseVersion = version.requireBaseVersion(entityId, event.base as any)
        return [buildWriteOp(handle, 'delete', { entityId, baseVersion, meta })]
    }

    if (event.type === 'patches') {
        const { upsertItems, deleteItems } = buildRestoreWriteItemsFromPatches({
            nextState: optimisticState,
            patches: event.patches,
            inversePatches: event.inversePatches,
            metaForItem: () => buildWriteItemMeta(runtime)
        })

        const ops: TranslatedWriteOp[] = []
        for (const item of upsertItems) {
            const outboundValue = await ensureOutbound(runtime, handle, (item as any).value as T, opContext)
            const nextItem = { ...(item as any), value: outboundValue } as WriteItem
            ops.push(buildWriteOp(handle, 'upsert', nextItem, {
                options: { merge: false, upsert: { mode: 'loose' } }
            }))
        }
        for (const item of deleteItems) {
            ops.push(buildWriteOp(handle, 'delete', item))
        }
        return ops
    }

    return []
}

function buildUpsertOptions(upsert?: { mode?: 'strict' | 'loose'; merge?: boolean }): WriteOptions | undefined {
    if (!upsert) return undefined
    const out: WriteOptions = {}
    if (typeof upsert.merge === 'boolean') out.merge = upsert.merge
    if (upsert.mode === 'strict' || upsert.mode === 'loose') out.upsert = { mode: upsert.mode }
    return Object.keys(out).length ? out : undefined
}

async function ensureOutbound<T extends Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, value: T, opContext?: OperationContext): Promise<T> {
    const processed = await runtime.transform.outbound(handle, value, opContext)
    if (processed === undefined) {
        throw new Error('[Atoma] transform returned empty for outbound write')
    }
    return processed
}

function buildWriteOp<T extends Entity>(handle: StoreHandle<T>, action: WriteAction, item: WriteItem, extra?: { options?: WriteOptions; intent?: 'created' }): TranslatedWriteOp {
    const op = Protocol.ops.build.buildWriteOp({
        opId: handle.nextOpId('w'),
        write: {
            resource: handle.storeName,
            action,
            items: [item],
            ...(extra?.options ? { options: extra.options } : {})
        }
    })
    return {
        op,
        action,
        ...(item.entityId ? { entityId: item.entityId } : {}),
        ...(extra?.intent ? { intent: extra.intent } : {})
    }
}

function buildWriteItemMeta(runtime: CoreRuntime): WriteItemMeta {
    const meta: WriteItemMeta = {
        idempotencyKey: Protocol.ids.createIdempotencyKey({ now: runtime.now }),
        clientTimeMs: runtime.now()
    }

    return Protocol.ops.meta.ensureWriteItemMeta({
        meta,
        now: runtime.now
    })
}

function buildRestoreWriteItemsFromPatches<T extends Entity>(args: {
    nextState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
    metaForItem: () => WriteItemMeta
}): { upsertItems: WriteItem[]; deleteItems: WriteItem[] } {
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

    const upsertItems: WriteItem[] = []
    const deleteItems: WriteItem[] = []

    for (const id of touchedIds.values()) {
        const meta = args.metaForItem()
        const next = args.nextState.get(id)
        if (next) {
            const baseVersion = version.resolvePositiveVersion(next)
            const item: WriteItem = {
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: next,
                meta
            }
            upsertItems.push(item)
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }
        deleteItems.push({ entityId: id, baseVersion, meta })
    }

    return { upsertItems, deleteItems }
}
