import type { Entity, OperationContext, WriteIntent, WriteIntentOptions } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { version } from 'atoma-shared'
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

    return []
}

export function buildUpsertOptions(upsert?: { mode?: 'strict' | 'loose'; merge?: boolean }): WriteIntentOptions | undefined {
    if (!upsert) return undefined
    const out: WriteIntentOptions = {}
    if (typeof upsert.merge === 'boolean') out.merge = upsert.merge
    if (upsert.mode === 'strict' || upsert.mode === 'loose') out.upsert = { mode: upsert.mode }
    return Object.keys(out).length ? out : undefined
}
