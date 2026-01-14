import type { Patch } from 'immer'
import type { Entity } from '../../../types'
import type { Plan } from '../types'
import type { StoreDispatchEvent } from '../../../types'
import { Protocol, type EntityId, type WriteAction, type WriteItem, type WriteItemMeta, type WriteOptions } from '#protocol'
import { Shared } from '#shared'

type TranslatedWrite = {
    action: WriteAction
    items: WriteItem[]
    options?: WriteOptions
    intent?: 'created'
    requireCreatedData?: boolean
}

function buildRestoreWriteItemsFromPatchesPlan<T extends Entity>(args: {
    plan: Plan<T>
    metaForItem: () => WriteItemMeta
}): { upsertItems: WriteItem[]; deleteItems: WriteItem[] } {
    const touchedIds = new Set<EntityId>()
    ;(args.plan.patches as Patch[]).forEach(p => {
        const root = (p as any)?.path?.[0]
        if (Shared.entityId.isEntityId(root)) touchedIds.add(root)
    })

    const inverseRootAdds = Shared.immer.collectInverseRootAddsByEntityId(args.plan.inversePatches)
    const baseVersionByDeletedId = new Map<EntityId, number>()
    inverseRootAdds.forEach((value, id) => {
        baseVersionByDeletedId.set(id, Shared.version.requireBaseVersion(id, value))
    })

    const upsertItems: WriteItem[] = []
    const deleteItems: WriteItem[] = []

    for (const id of touchedIds.values()) {
        const meta = args.metaForItem()
        const next = args.plan.nextState.get(id)
        if (next) {
            const baseVersion = Shared.version.resolvePositiveVersion(next)
            upsertItems.push({
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: next,
                meta
            } as any)
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }
        deleteItems.push({ entityId: id, baseVersion, meta } as any)
    }

    return { upsertItems, deleteItems }
}

function writeItemMetaForIndex(args: {
    operations: Array<StoreDispatchEvent<any>>
    idx: number
    fallbackClientTimeMs: number
}): WriteItemMeta {
    const ticket = args.operations[args.idx]?.ticket
    const clientTimeMs = (typeof ticket?.clientTimeMs === 'number' && Number.isFinite(ticket.clientTimeMs))
        ? ticket.clientTimeMs
        : args.fallbackClientTimeMs
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

function readEntityId(value: unknown): EntityId | null {
    return Shared.entityId.toEntityId((value as any)?.id)
}

export function translatePlanToWrites<T extends Entity>(args: {
    plan: Plan<T>
    operations: Array<StoreDispatchEvent<T>>
    fallbackClientTimeMs: number
    mode: 'direct' | 'outbox'
}): TranslatedWrite[] {
    const types = args.plan.operationTypes

    if (types.length === 1 && types[0] === 'patches') {
        const metaForItem = () => Protocol.ops.meta.ensureWriteItemMeta({
            meta: { clientTimeMs: args.fallbackClientTimeMs },
            now: () => Date.now()
        })
        const { upsertItems, deleteItems } = buildRestoreWriteItemsFromPatchesPlan({
            plan: args.plan,
            metaForItem
        })
        const out: TranslatedWrite[] = []
        if (upsertItems.length) {
            out.push({
                action: 'upsert',
                items: upsertItems,
                options: { merge: false, upsert: { mode: 'loose' } }
            })
        }
        if (deleteItems.length) {
            out.push({
                action: 'delete',
                items: deleteItems
            })
        }
        return out
    }

    const createClientAssigned: WriteItem[] = []
    const createServerAssigned: WriteItem[] = []
    const updateItems: WriteItem[] = []
    const deleteItems: WriteItem[] = []
    const upsertByOptions = new Map<string, { options?: WriteOptions; items: WriteItem[] }>()

    for (let idx = 0; idx < types.length; idx++) {
        const type = types[idx]
        const value = args.plan.appliedData[idx]
        if (!type || !value) continue
        if (type === 'hydrate' || type === 'hydrateMany') continue

        const meta = writeItemMetaForIndex({ operations: args.operations, idx, fallbackClientTimeMs: args.fallbackClientTimeMs })

        if (type === 'add') {
            const entityId = readEntityId(value)
            if (entityId === null) continue
            createClientAssigned.push({ entityId, value, meta } as any)
            continue
        }

        if (type === 'create') {
            if (args.mode === 'outbox') {
                throw new Error('[Atoma] server-assigned create cannot be persisted via outbox')
            }
            createServerAssigned.push({ value, meta } as any)
            continue
        }

        if (type === 'update' || type === 'remove') {
            const entityId = readEntityId(value)
            if (entityId === null) continue
            updateItems.push({ entityId, baseVersion: Shared.version.requireBaseVersion(entityId, value), value, meta } as any)
            continue
        }

        if (type === 'forceRemove') {
            const entityId = readEntityId(value)
            if (entityId === null) continue
            deleteItems.push({ entityId, baseVersion: Shared.version.requireBaseVersion(entityId, value), meta } as any)
            continue
        }

        if (type === 'upsert') {
            const entityId = readEntityId(value)
            if (entityId === null) continue
            const baseVersion = Shared.version.resolvePositiveVersion(value)

            const options = Shared.writeOptions.upsertWriteOptionsFromDispatch(args.operations[idx])
            const key = Shared.key.optionsKey(options)
            const entry = upsertByOptions.get(key) ?? (() => {
                const next = { options, items: [] as WriteItem[] }
                upsertByOptions.set(key, next)
                return next
            })()

            entry.items.push({
                entityId,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value,
                meta
            } as any)
            continue
        }
    }

    const out: TranslatedWrite[] = []
    if (createClientAssigned.length) {
        out.push({ action: 'create', items: createClientAssigned, intent: 'created', requireCreatedData: false })
    }
    if (createServerAssigned.length) {
        out.push({ action: 'create', items: createServerAssigned, intent: 'created', requireCreatedData: true })
    }
    for (const entry of upsertByOptions.values()) {
        if (!entry.items.length) continue
        out.push({ action: 'upsert', items: entry.items, ...(entry.options ? { options: entry.options } : {}) })
    }
    if (updateItems.length) {
        out.push({ action: 'update', items: updateItems })
    }
    if (deleteItems.length) {
        out.push({ action: 'delete', items: deleteItems })
    }

    return out
}
