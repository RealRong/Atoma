import type { Patch } from 'immer'
import { Protocol, type EntityId, type WriteOptions, type WriteIntent } from '#protocol'
import type { Entity, OutboxEnqueuer, StoreDispatchEvent } from '../../../types'
import type { Persister, PersisterPersistArgs, PersisterPersistResult } from '../types'

function toEntityId(id: unknown): EntityId | null {
    return (typeof id === 'string' && id.length > 0) ? id : null
}

function resolveVersion(value: unknown): number | undefined {
    const v = value && typeof value === 'object' ? (value as any).version : undefined
    return (typeof v === 'number' && Number.isFinite(v)) ? v : undefined
}

function requireBaseVersion(id: EntityId, value: unknown): number {
    const v = resolveVersion(value)
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    throw new Error(`[Atoma] write requires baseVersion (missing version for id=${String(id)})`)
}

function stableStringify(value: any): string {
    if (value === null || value === undefined) return String(value)
    if (typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    const keys = Object.keys(value).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`
}

function optionsKey(options: WriteOptions | undefined): string {
    if (!options) return ''
    return stableStringify(options)
}

function upsertWriteOptions(op: StoreDispatchEvent<any> | undefined): WriteOptions | undefined {
    if (!op || op.type !== 'upsert') return undefined
    const mode = op.upsert?.mode
    const merge = op.upsert?.merge

    const out: WriteOptions = {}
    if (typeof merge === 'boolean') out.merge = merge
    if (mode === 'strict' || mode === 'loose') out.upsert = { mode }

    return Object.keys(out).length ? out : undefined
}

export class OutboxPersister implements Persister {
    constructor(private readonly sync: OutboxEnqueuer) { }

    async persist<T extends Entity>(args: PersisterPersistArgs<T>): Promise<PersisterPersistResult<T>> {
        const resource = args.handle.storeName
        const fallbackClientTimeMs = args.metadata.timestamp
        const inverseRootAddsById = new Map<EntityId, unknown>()
        try {
            const inverse = args.plan.inversePatches
            if (Array.isArray(inverse)) {
                inverse.forEach((p: any) => {
                    if (p?.op !== 'add') return
                    const path = p?.path
                    if (!Array.isArray(path) || path.length !== 1) return
                    const id = toEntityId(path[0])
                    if (id === null) return
                    inverseRootAddsById.set(id, p.value)
                })
            }
        } catch {
            // ignore
        }

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
        if (types.includes('create' as any)) {
            throw new Error('[Atoma] server-assigned create cannot be persisted via outbox')
        }

        if (types.length === 1 && types[0] === 'patches') {
            const patches = args.plan.patches
            const patchesByItemId = new Map<EntityId, Patch[]>()
            patches.forEach((p: Patch) => {
                const itemId = toEntityId((p as any)?.path?.[0])
                if (itemId === null) return
                if (!patchesByItemId.has(itemId)) patchesByItemId.set(itemId, [])
                patchesByItemId.get(itemId)!.push(p)
            })

            // patches 可能覆盖多个 entityId：绝不能让多个 write items 共享同一个 idempotencyKey
            const opMeta = { clientTimeMs: fallbackClientTimeMs }

            const createItems: Array<{ entityId: EntityId; value: unknown }> = []
            const updateItems: Array<{ entityId: EntityId; value: unknown; baseVersion: number }> = []
            const deleteItems: Array<{ entityId: EntityId; baseVersion: number }> = []

            for (const [id, itemPatches] of patchesByItemId.entries()) {
                const entityId = id

                const isDelete = itemPatches.some(p => p.op === 'remove' && p.path.length === 1)
                if (isDelete) {
                    const baseVersion = requireBaseVersion(id, inverseRootAddsById.get(id))
                    deleteItems.push({ entityId, baseVersion })
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
                    updateItems.push({ entityId, value: val, baseVersion: requireBaseVersion(id, val) })
                    continue
                }

                const next = args.handle.jotaiStore.get(args.handle.atom).get(id)
                if (!next) {
                    throw new Error(`[Atoma] outbox: patches item missing in atom (id=${String(id)})`)
                }
                updateItems.push({
                    entityId,
                    value: next,
                    baseVersion: requireBaseVersion(id, next)
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
                        baseVersion: i.baseVersion,
                        value: i.value,
                        meta: opMeta
                    }))
                })
            }
            if (deleteItems.length) {
                await enqueue({
                    kind: 'delete',
                    items: deleteItems.map(i => ({
                        entityId: i.entityId,
                        baseVersion: i.baseVersion,
                        meta: opMeta
                    }))
                })
            }

            return
        }

        const createItems: Array<{ entityId: EntityId; value: unknown; meta?: any }> = []
        const updateItems: Array<{ entityId: EntityId; value: unknown; baseVersion: number; meta?: any }> = []
        const deleteItems: Array<{ entityId: EntityId; baseVersion: number; meta?: any }> = []
        const upsertItemsByOptions = new Map<string, {
            options?: WriteOptions
            items: Array<{ entityId: EntityId; value: unknown; baseVersion?: number; meta?: any }>
        }>()

        for (let i = 0; i < types.length; i++) {
            const type = types[i]
            const value = args.plan.appliedData[i]
            if (!type) continue
            const meta = metaForOpIndex(i)

            if (type === 'add') {
                const id = toEntityId((value as any)?.id)
                if (id === null) continue
                createItems.push({ entityId: id, value, meta })
                continue
            }

            if (type === 'update' || type === 'remove') {
                const id = toEntityId((value as any)?.id)
                if (id === null) continue
                updateItems.push({ entityId: id, value, baseVersion: requireBaseVersion(id, value), meta })
                continue
            }

            if (type === 'forceRemove') {
                const id = toEntityId((value as any)?.id)
                if (id === null) continue
                const baseVersion = requireBaseVersion(id, inverseRootAddsById.get(id))
                deleteItems.push({ entityId: id, baseVersion, meta })
                continue
            }

            if (type === 'upsert') {
                const id = toEntityId((value as any)?.id)
                if (id === null) continue
                const baseVersion = resolveVersion(value)
                const op = args.operations[i]
                const options = upsertWriteOptions(op)
                const key = optionsKey(options)
                const entry = upsertItemsByOptions.get(key) ?? (() => {
                    const next = { options, items: [] as Array<{ entityId: string; value: unknown; baseVersion?: number; meta?: any }> }
                    upsertItemsByOptions.set(key, next)
                    return next
                })()
                entry.items.push({
                    entityId: id,
                    value,
                    ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                    meta
                })
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
        if (upsertItemsByOptions.size) {
            for (const entry of upsertItemsByOptions.values()) {
                if (!entry.items.length) continue
                const intent: WriteIntent = {
                    kind: 'upsert',
                    items: entry.items.map(i => ({
                        entityId: i.entityId,
                        ...(typeof i.baseVersion === 'number' ? { baseVersion: i.baseVersion } : {}),
                        value: i.value,
                        meta: i.meta
                    }))
                } as any

                const { action, items } = Protocol.ops.encodeWriteIntent(intent)
                if (!items.length) continue
                await this.sync.enqueueWrite({
                    resource,
                    action,
                    items,
                    ...(entry.options ? { options: entry.options } : {})
                })
            }
        }
        if (updateItems.length) {
            await enqueue({
                kind: 'update',
                items: updateItems.map(i => ({
                    entityId: i.entityId,
                    baseVersion: i.baseVersion,
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
                    baseVersion: i.baseVersion,
                    meta: i.meta
                }))
            })
        }
    }
}
