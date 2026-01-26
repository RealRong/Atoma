/**
 * Mutation Pipeline: Write Intents
 * Purpose: Converts dispatch events or patches into protocol write intents.
 * Call chain: buildLocalMutationPlan -> buildWriteIntentsFromEvents/buildWriteIntentsFromPatches -> translateWriteIntentsToOps.
 */
import type { Patch } from 'immer'
import { Protocol, type EntityId, type WriteAction, type WriteItem, type WriteItemMeta, type WriteOptions } from '#protocol'
import { Shared } from '#shared'
import type { Entity, StoreDispatchEvent } from '../../types'
import type { WriteIntent } from './types'

export function buildWriteIntentsFromEvents<T extends Entity>(args: {
    writeEvents: Array<StoreDispatchEvent<T>>
    optimisticState: Map<EntityId, T>
    baseState: Map<EntityId, T>
    fallbackClientTimeMs: number
}): WriteIntent[] {
    const { intents, pushIntent } = createIntentCollector()

    for (const op of args.writeEvents) {
        if (op.type === 'hydrate' || op.type === 'hydrateMany') continue

        const meta = writeItemMetaForTicket({
            ticket: op.ticket,
            fallbackClientTimeMs: args.fallbackClientTimeMs
        })

        if (op.type === 'add') {
            const entityId = op.data.id
            const value = args.optimisticState.get(entityId) ?? op.data
            pushIntent({
                action: 'create',
                item: { entityId, value, meta },
                intent: 'created',
                requireCreatedData: false
            })
            continue
        }

        if (op.type === 'update' || op.type === 'remove') {
            const entityId = op.data.id
            const value = args.optimisticState.get(entityId)
            if (!value) continue
            const baseForVersion = args.baseState.get(entityId) ?? value
            pushIntent({
                action: 'update',
                item: { entityId, baseVersion: Shared.version.requireBaseVersion(entityId, baseForVersion), value, meta }
            })
            continue
        }

        if (op.type === 'forceRemove') {
            const entityId = op.data.id
            const base = args.baseState.get(entityId) ?? op.data
            pushIntent({
                action: 'delete',
                item: { entityId, baseVersion: Shared.version.requireBaseVersion(entityId, base), meta }
            })
            continue
        }

        if (op.type === 'upsert') {
            const entityId = op.data.id
            const value = args.optimisticState.get(entityId)
            if (!value) continue
            const baseVersion = Shared.version.resolvePositiveVersion(value)
            const options = Shared.writeOptions.upsertWriteOptionsFromDispatch(op)
            pushIntent({
                action: 'upsert',
                item: {
                    entityId,
                    ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                    value,
                    meta
                },
                ...(options ? { options } : {})
            })
            continue
        }
    }

    return intents
}

export function buildWriteIntentsFromPatches<T extends Entity>(args: {
    optimisticState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
    fallbackClientTimeMs: number
}): WriteIntent[] {
    const { intents, pushIntent } = createIntentCollector()

    collectIntentsFromPatches({
        pushIntent,
        optimisticState: args.optimisticState,
        patches: args.patches,
        inversePatches: args.inversePatches,
        fallbackClientTimeMs: args.fallbackClientTimeMs
    })

    return intents
}

function createIntentCollector() {
    const intents: WriteIntent[] = []
    const pushIntent = (w: { action: WriteAction; item: WriteItem; options?: WriteOptions; intent?: 'created'; requireCreatedData?: boolean }) => {
        const entityId = w.item.entityId
        intents.push({
            action: w.action,
            item: w.item,
            ...(w.options ? { options: w.options } : {}),
            ...(entityId ? { entityId } : {}),
            ...(w.intent ? { intent: w.intent } : {}),
            ...(typeof w.requireCreatedData === 'boolean' ? { requireCreatedData: w.requireCreatedData } : {})
        })
    }
    return { intents, pushIntent }
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
        if (Shared.entityId.isEntityId(root)) touchedIds.add(root as EntityId)
    })

    const inverseRootAdds = Shared.immer.collectInverseRootAddsByEntityId(args.inversePatches)
    const baseVersionByDeletedId = new Map<EntityId, number>()
    inverseRootAdds.forEach((value, id) => {
        baseVersionByDeletedId.set(id, Shared.version.requireBaseVersion(id, value))
    })

    const upsertItems: WriteItem[] = []
    const deleteItems: WriteItem[] = []

    for (const id of touchedIds.values()) {
        const meta = args.metaForItem()
        const next = args.nextState.get(id)
        if (next) {
            const baseVersion = Shared.version.resolvePositiveVersion(next)
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

function writeItemMetaForTicket(args: {
    ticket: StoreDispatchEvent<any>['ticket']
    fallbackClientTimeMs: number
}): WriteItemMeta {
    const { ticket, fallbackClientTimeMs } = args
    const clientTimeMs = (typeof ticket?.clientTimeMs === 'number' && Number.isFinite(ticket.clientTimeMs))
        ? ticket.clientTimeMs
        : fallbackClientTimeMs
    const idempotencyKey = (typeof ticket?.idempotencyKey === 'string' && ticket.idempotencyKey)
        ? ticket.idempotencyKey
        : undefined

    return Protocol.ops.meta.ensureWriteItemMeta({
        meta: {
            clientTimeMs,
            ...(idempotencyKey ? { idempotencyKey } : {})
        },
        now: () => Date.now()
    })
}

function collectIntentsFromPatches<T extends Entity>(args: {
    pushIntent: (w: { action: WriteAction; item: WriteItem; options?: WriteOptions; intent?: 'created'; requireCreatedData?: boolean }) => void
    optimisticState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
    fallbackClientTimeMs: number
}) {
    const metaForItem = () => Protocol.ops.meta.ensureWriteItemMeta({
        meta: { clientTimeMs: args.fallbackClientTimeMs },
        now: () => Date.now()
    })
    const { upsertItems, deleteItems } = buildRestoreWriteItemsFromPatches({
        nextState: args.optimisticState,
        patches: args.patches,
        inversePatches: args.inversePatches,
        metaForItem
    })

    for (const item of upsertItems) {
        args.pushIntent({
            action: 'upsert',
            item,
            options: { merge: false, upsert: { mode: 'loose' } }
        })
    }
    for (const item of deleteItems) {
        args.pushIntent({ action: 'delete', item })
    }
}
