import type { Patch } from 'immer'
import { Protocol } from '#protocol'
import type { WriteIntent } from '../../../../protocol/ops/encodeWrite'
import type { SyncClient } from '../../../../sync'
import type { Entity, StoreKey } from '../../../types'
import type { Persister, PersisterPersistArgs, PersisterPersistResult } from '../types'

function toStoreKey(id: unknown): StoreKey | null {
    if (typeof id === 'string') return id
    if (typeof id === 'number' && Number.isFinite(id)) return id
    return null
}

function resolveVersion(value: unknown): number | undefined {
    const v = value && typeof value === 'object' ? (value as any).version : undefined
    return (typeof v === 'number' && Number.isFinite(v)) ? v : undefined
}

export class OutboxPersister implements Persister {
    constructor(private readonly sync: SyncClient) { }

    async persist<T extends Entity>(args: PersisterPersistArgs<T>): Promise<PersisterPersistResult<T>> {
        const resource = args.handle.storeName
        const fallbackClientTimeMs = args.metadata.timestamp

        const metaForOpIndex = (idx: number) => {
            const ticket = args.operations[idx]?.ticket
            const clientTimeMs = typeof ticket?.clientTimeMs === 'number' ? ticket.clientTimeMs : fallbackClientTimeMs
            const idempotencyKey = typeof ticket?.idempotencyKey === 'string' && ticket.idempotencyKey ? ticket.idempotencyKey : undefined
            if (typeof clientTimeMs !== 'number') return undefined
            return {
                clientTimeMs,
                ...(idempotencyKey ? { idempotencyKey } : {})
            }
        }

        const enqueue = async (intent: WriteIntent) => {
            const { action, items } = Protocol.ops.encodeWriteIntent(intent)
            if (!items.length) return
            await this.sync.enqueueWrite({
                resource,
                action,
                items
            })
        }

        const types = args.plan.operationTypes

        if (types.length === 1 && types[0] === 'patches') {
            const patches = args.plan.patches
            const patchesByItemId = new Map<StoreKey, Patch[]>()
            patches.forEach((p: Patch) => {
                const itemId = toStoreKey((p as any)?.path?.[0])
                if (itemId === null) return
                if (!patchesByItemId.has(itemId)) patchesByItemId.set(itemId, [])
                patchesByItemId.get(itemId)!.push(p)
            })

            const opMeta = metaForOpIndex(0)

            const createItems: Array<{ entityId: string; value: unknown }> = []
            const updateItems: Array<{ entityId: string; value: unknown; baseVersion?: number }> = []
            const patchItems: Array<{ entityId: string; baseVersion: number; patches: Patch[]; rootEntityId: string | number }> = []
            const deleteItems: Array<{ entityId: string; baseVersion?: number }> = []

            for (const [id, itemPatches] of patchesByItemId.entries()) {
                const entityId = String(id)

                const isDelete = itemPatches.some(p => p.op === 'remove' && p.path.length === 1)
                if (isDelete) {
                    const cur = args.handle.jotaiStore.get(args.handle.atom).get(id as any)
                    deleteItems.push({ entityId, baseVersion: resolveVersion(cur) })
                    continue
                }

                const rootAdd = itemPatches.find(p => p.op === 'add' && p.path.length === 1)
                if (rootAdd) {
                    createItems.push({ entityId, value: (rootAdd as any).value })
                    continue
                }

                const rootReplace = itemPatches.find(p => (p.op === 'add' || p.op === 'replace') && p.path.length === 1)
                if (rootReplace) {
                    const val = (rootReplace as any).value
                    updateItems.push({ entityId, value: val, baseVersion: resolveVersion(val) })
                    continue
                }

                const cur = args.handle.jotaiStore.get(args.handle.atom).get(id as any)
                const baseVersion = resolveVersion(cur) ?? 0
                patchItems.push({
                    entityId,
                    baseVersion,
                    patches: itemPatches,
                    rootEntityId: id
                })
            }

            if (createItems.length) {
                await enqueue({
                    kind: 'create',
                    items: createItems.map(i => ({
                        entityId: i.entityId,
                        value: i.value,
                        meta: opMeta
                    }))
                })
            }
            if (updateItems.length) {
                await enqueue({
                    kind: 'update',
                    items: updateItems.map(i => ({
                        entityId: i.entityId,
                        ...(typeof i.baseVersion === 'number' ? { baseVersion: i.baseVersion } : {}),
                        value: i.value,
                        meta: opMeta
                    }))
                })
            }
            if (patchItems.length) {
                await enqueue({
                    kind: 'patch',
                    items: patchItems.map(i => ({
                        entityId: i.entityId,
                        baseVersion: i.baseVersion,
                        patches: i.patches,
                        rootEntityId: i.rootEntityId,
                        meta: opMeta
                    }))
                })
            }
            if (deleteItems.length) {
                await enqueue({
                    kind: 'delete',
                    items: deleteItems.map(i => ({
                        entityId: i.entityId,
                        ...(typeof i.baseVersion === 'number' ? { baseVersion: i.baseVersion } : {}),
                        meta: opMeta
                    }))
                })
            }

            return
        }

        const createItems: Array<{ entityId: string; value: unknown; meta?: any }> = []
        const updateItems: Array<{ entityId: string; value: unknown; baseVersion?: number; meta?: any }> = []
        const deleteItems: Array<{ entityId: string; baseVersion?: number; meta?: any }> = []

        for (let i = 0; i < types.length; i++) {
            const type = types[i]
            const value = args.plan.appliedData[i]
            if (!type) continue
            const meta = metaForOpIndex(i)

            if (type === 'add') {
                const id = toStoreKey((value as any)?.id)
                if (id === null) continue
                createItems.push({ entityId: String(id), value, meta })
                continue
            }

            if (type === 'update' || type === 'remove') {
                const id = toStoreKey((value as any)?.id)
                if (id === null) continue
                updateItems.push({ entityId: String(id), value, baseVersion: resolveVersion(value), meta })
                continue
            }

            if (type === 'forceRemove') {
                const id = toStoreKey((value as any)?.id)
                if (id === null) continue
                deleteItems.push({ entityId: String(id), baseVersion: resolveVersion(value), meta })
                continue
            }
        }

        if (createItems.length) {
            await enqueue({
                kind: 'create',
                items: createItems.map(i => ({
                    entityId: i.entityId,
                    value: i.value,
                    meta: i.meta
                }))
            })
        }
        if (updateItems.length) {
            await enqueue({
                kind: 'update',
                items: updateItems.map(i => ({
                    entityId: i.entityId,
                    ...(typeof i.baseVersion === 'number' ? { baseVersion: i.baseVersion } : {}),
                    value: i.value,
                    meta: i.meta
                }))
            })
        }
        if (deleteItems.length) {
            await enqueue({
                kind: 'delete',
                items: deleteItems.map(i => ({
                    entityId: i.entityId,
                    ...(typeof i.baseVersion === 'number' ? { baseVersion: i.baseVersion } : {}),
                    meta: i.meta
                }))
            })
        }
    }
}
