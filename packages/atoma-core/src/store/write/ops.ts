import type { Entity, OperationContext, WriteIntent, WriteIntentOptions } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { entityId as entityIdUtils, immer as immerUtils, version } from 'atoma-shared'
import type { Patch } from 'immer'
import type { WriteEvent } from './events'

export async function buildWriteIntents<T extends Entity>(args: {
    event: WriteEvent<T>
    optimisticState: Map<EntityId, T>
    opContext?: OperationContext
    prepareValue?: (value: T, ctx?: OperationContext) => Promise<T>
}): Promise<WriteIntent<T>[]> {
    const { event, optimisticState, prepareValue, opContext } = args

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
        return [{ action: 'create', value: outbound, entityId, intent: 'created' }]
    }

    if (event.type === 'update') {
        const entityId = event.data.id as EntityId
        const baseVersion = version.requireBaseVersion(entityId, event.base as any)
        const value = optimisticState.get(entityId) ?? (event.data as T)
        const outbound = await prepare(value as T)
        return [{ action: 'update', entityId, baseVersion, value: outbound }]
    }

    if (event.type === 'upsert') {
        const entityId = event.data.id as EntityId
        const value = optimisticState.get(entityId) ?? (event.data as T)
        const outbound = await prepare(value as T)
        const baseVersion = version.resolvePositiveVersion(value as any)
        const options = buildUpsertOptions(event.upsert)
        return [{
            action: 'upsert',
            entityId,
            ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
            value: outbound,
            ...(options ? { options } : {})
        }]
    }

    if (event.type === 'remove') {
        const entityId = event.data.id as EntityId
        const baseVersion = version.requireBaseVersion(entityId, event.base as any)
        const value = optimisticState.get(entityId)
        if (!value) return []
        const outbound = await prepare(value as T)
        return [{ action: 'update', entityId, baseVersion, value: outbound }]
    }

    if (event.type === 'forceRemove') {
        const entityId = event.data.id as EntityId
        const baseVersion = version.requireBaseVersion(entityId, event.base as any)
        return [{ action: 'delete', entityId, baseVersion }]
    }

    if (event.type === 'patches') {
        const { upsertItems, deleteItems } = buildRestoreWriteItemsFromPatches({
            nextState: optimisticState,
            patches: event.patches,
            inversePatches: event.inversePatches
        })

        const intents: WriteIntent<T>[] = []
        for (const item of upsertItems) {
            const outboundValue = await prepare((item as any).value as T)
            intents.push({
                action: 'upsert',
                entityId: (item as any).entityId as EntityId | undefined,
                baseVersion: (item as any).baseVersion as any,
                value: outboundValue as any,
                options: { merge: false, upsert: { mode: 'loose' } }
            })
        }
        for (const item of deleteItems) {
            intents.push({
                action: 'delete',
                entityId: (item as any).entityId as EntityId | undefined,
                baseVersion: (item as any).baseVersion as any
            })
        }
        return intents
    }

    return []
}

export function buildUpsertOptions(upsert?: { mode?: 'strict' | 'loose'; merge?: boolean }): WriteIntentOptions | undefined {
    if (!upsert) return undefined
    const out: WriteIntentOptions = {}
    if (typeof upsert.merge === 'boolean') out.merge = upsert.merge
    if (upsert.mode === 'strict' || upsert.mode === 'loose') out.upsert = { mode: upsert.mode }
    return Object.keys(out).length ? out : undefined
}

export function buildRestoreWriteItemsFromPatches<T extends Entity>(args: {
    nextState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
}): { upsertItems: any[]; deleteItems: any[] } {
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

    const upsertItems: any[] = []
    const deleteItems: any[] = []

    for (const id of touchedIds.values()) {
        const next = args.nextState.get(id)
        if (next) {
            const baseVersion = version.resolvePositiveVersion(next)
            const item: any = {
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: next
            }
            upsertItems.push(item)
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }
        deleteItems.push({ entityId: id, baseVersion })
    }

    return { upsertItems, deleteItems }
}
