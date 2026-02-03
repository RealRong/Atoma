import type { Entity, OperationContext } from 'atoma-types/core'
import type { EntityId, Operation, WriteAction, WriteItem, WriteItemMeta, WriteOptions } from 'atoma-types/protocol'
import { Protocol } from 'atoma-protocol'
import { entityId as entityIdUtils, immer as immerUtils, version } from 'atoma-shared'
import type { Patch } from 'immer'
import type { WriteEvent } from './writeEvents'

export type WriteOpSpec = Readonly<{
    action: WriteAction
    item: WriteItem
    options?: WriteOptions
    intent?: 'created'
    entityId?: EntityId
}>

export async function buildWriteOpSpecs<T extends Entity>(args: {
    event: WriteEvent<T>
    optimisticState: Map<EntityId, T>
    opContext?: OperationContext
    metaForItem: () => WriteItemMeta
    prepareValue?: (value: T, ctx?: OperationContext) => Promise<T>
}): Promise<WriteOpSpec[]> {
    const { event, optimisticState, metaForItem, prepareValue, opContext } = args

    const prepare = async (value: T): Promise<T> => {
        if (!prepareValue) return value
        const processed = await prepareValue(value, opContext)
        if (processed === undefined) {
            throw new Error('[Atoma] transform returned empty for outbound write')
        }
        return processed
    }

    if (event.type === 'add') {
        const entityId = event.data.id as EntityId
        const value = optimisticState.get(entityId) ?? (event.data as T)
        const outbound = await prepare(value as T)
        const item: WriteItem = {
            ...(entityId ? { entityId } : {}),
            value: outbound,
            meta: metaForItem()
        }
        return [{ action: 'create', item, intent: 'created', entityId }]
    }

    if (event.type === 'update') {
        const entityId = event.data.id as EntityId
        const baseVersion = version.requireBaseVersion(entityId, event.base as any)
        const value = optimisticState.get(entityId) ?? (event.data as T)
        const outbound = await prepare(value as T)
        const item: WriteItem = {
            entityId,
            baseVersion,
            value: outbound,
            meta: metaForItem()
        }
        return [{ action: 'update', item, entityId }]
    }

    if (event.type === 'upsert') {
        const entityId = event.data.id as EntityId
        const value = optimisticState.get(entityId) ?? (event.data as T)
        const outbound = await prepare(value as T)
        const baseVersion = version.resolvePositiveVersion(value as any)
        const item: WriteItem = {
            entityId,
            ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
            value: outbound,
            meta: metaForItem()
        }
        const options = buildUpsertOptions(event.upsert)
        return [{ action: 'upsert', item, ...(options ? { options } : {}), entityId }]
    }

    if (event.type === 'remove') {
        const entityId = event.data.id as EntityId
        const baseVersion = version.requireBaseVersion(entityId, event.base as any)
        const value = optimisticState.get(entityId)
        if (!value) return []
        const outbound = await prepare(value as T)
        const item: WriteItem = {
            entityId,
            baseVersion,
            value: outbound,
            meta: metaForItem()
        }
        return [{ action: 'update', item, entityId }]
    }

    if (event.type === 'forceRemove') {
        const entityId = event.data.id as EntityId
        const baseVersion = version.requireBaseVersion(entityId, event.base as any)
        const item: WriteItem = {
            entityId,
            baseVersion,
            meta: metaForItem()
        }
        return [{ action: 'delete', item, entityId }]
    }

    if (event.type === 'patches') {
        const { upsertItems, deleteItems } = buildRestoreWriteItemsFromPatches({
            nextState: optimisticState,
            patches: event.patches,
            inversePatches: event.inversePatches,
            metaForItem
        })

        const specs: WriteOpSpec[] = []
        for (const item of upsertItems) {
            const outboundValue = await prepare((item as any).value as T)
            const nextItem = { ...(item as any), value: outboundValue } as WriteItem
            specs.push({
                action: 'upsert',
                item: nextItem,
                options: { merge: false, upsert: { mode: 'loose' } },
                entityId: (item as any).entityId as EntityId | undefined
            })
        }
        for (const item of deleteItems) {
            specs.push({
                action: 'delete',
                item,
                entityId: (item as any).entityId as EntityId | undefined
            })
        }
        return specs
    }

    return []
}

export function buildWriteOperation(args: {
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

export function buildWriteItemMeta(args: { now: () => number }): WriteItemMeta {
    const meta: WriteItemMeta = {
        idempotencyKey: Protocol.ids.createIdempotencyKey({ now: args.now }),
        clientTimeMs: args.now()
    }

    return Protocol.ops.meta.ensureWriteItemMeta({
        meta,
        now: args.now
    })
}

export function buildUpsertOptions(upsert?: { mode?: 'strict' | 'loose'; merge?: boolean }): WriteOptions | undefined {
    if (!upsert) return undefined
    const out: WriteOptions = {}
    if (typeof upsert.merge === 'boolean') out.merge = upsert.merge
    if (upsert.mode === 'strict' || upsert.mode === 'loose') out.upsert = { mode: upsert.mode }
    return Object.keys(out).length ? out : undefined
}

export function buildRestoreWriteItemsFromPatches<T extends Entity>(args: {
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