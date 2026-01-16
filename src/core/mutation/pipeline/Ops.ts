import type { Patch } from 'immer'
import type { ObservabilityContext } from '#observability'
import { Protocol, type EntityId, type Operation, type OperationResult, type StandardError, type WriteAction, type WriteItem, type WriteItemMeta, type WriteItemResult, type WriteOp, type WriteOptions, type WriteResultData } from '#protocol'
import { Shared } from '#shared'
import type { Entity, PersistWriteback, StoreDispatchEvent, StoreHandle } from '../../types'
import { executeOps } from '../../ops/opsExecutor'
import type { TranslatedWriteOp } from './types'

export function translateMutationToWriteOps<T extends Entity>(args: {
    handle: StoreHandle<T>
    operations: Array<StoreDispatchEvent<T>>
    optimisticState: Map<EntityId, T>
    baseState: Map<EntityId, T>
    fallbackClientTimeMs: number
    persistMode: 'direct' | 'outbox'
}): TranslatedWriteOp[] {
    const out: TranslatedWriteOp[] = []

    const pushOp = (w: { action: WriteAction; item: WriteItem; options?: WriteOptions; intent?: 'created'; requireCreatedData?: boolean }) => {
        const op: WriteOp = Protocol.ops.build.buildWriteOp({
            opId: args.handle.nextOpId('w'),
            write: {
                resource: args.handle.storeName,
                action: w.action,
                items: [w.item],
                ...(w.options ? { options: w.options } : {})
            }
        })
        const entityId = w.item.entityId
        out.push({
            op,
            action: w.action,
            ...(entityId ? { entityId } : {}),
            ...(w.intent ? { intent: w.intent } : {}),
            ...(typeof w.requireCreatedData === 'boolean' ? { requireCreatedData: w.requireCreatedData } : {})
        })
    }

    const patchesOp = args.operations.find((o): o is Extract<StoreDispatchEvent<T>, { type: 'patches' }> => o.type === 'patches')
    if (patchesOp) {
        translatePatchesToWriteOps({
            pushOp,
            optimisticState: args.optimisticState,
            patches: patchesOp.patches,
            inversePatches: patchesOp.inversePatches,
            fallbackClientTimeMs: args.fallbackClientTimeMs
        })
        return out
    }

    for (const [idx, op] of args.operations.entries()) {
        if (op.type === 'hydrate' || op.type === 'hydrateMany') continue

        const meta = writeItemMetaForTicket({
            ticket: op.ticket,
            fallbackClientTimeMs: args.fallbackClientTimeMs
        })

        if (op.type === 'add') {
            const entityId = op.data.id
            const value = args.optimisticState.get(entityId) ?? op.data
            pushOp({
                action: 'create',
                item: { entityId, value, meta },
                intent: 'created',
                requireCreatedData: false
            })
            continue
        }

        if (op.type === 'create') {
            if (args.persistMode === 'outbox') {
                throw new Error('[Atoma] server-assigned create cannot be persisted via outbox')
            }
            pushOp({
                action: 'create',
                item: { value: op.data, meta },
                intent: 'created',
                requireCreatedData: true
            })
            continue
        }

        if (op.type === 'update' || op.type === 'remove') {
            const entityId = op.data.id
            const value = args.optimisticState.get(entityId)
            if (!value) continue
            pushOp({
                action: 'update',
                item: { entityId, baseVersion: Shared.version.requireBaseVersion(entityId, value), value, meta }
            })
            continue
        }

        if (op.type === 'forceRemove') {
            const entityId = op.data.id
            const base = args.baseState.get(entityId) ?? op.data
            pushOp({
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
            pushOp({
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

    return out
}

export async function executeWriteOps<T extends Entity>(args: {
    handle: StoreHandle<T>
    ops: Array<TranslatedWriteOp>
    context?: ObservabilityContext
}): Promise<{ created?: T[]; writeback?: PersistWriteback<T> }> {
    const ops = args.ops.map(o => o.op)
    if (!ops.length) return {}

    const results = await executeOps(args.handle, ops, args.context)
    const resultByOpId = new Map<string, OperationResult>()
    results.forEach(r => resultByOpId.set(r.opId, r))

    const created: T[] = []
    const upserts: T[] = []
    const versionUpdates: Array<{ key: EntityId; version: number }> = []

    for (const entry of args.ops) {
        const result = findOpResult(resultByOpId, entry.op.opId)
        if (!result.ok) {
            const err = new Error(`[Atoma] op failed: ${result.error.message || 'Operation failed'}`)
            ;(err as { error?: unknown }).error = result.error
            throw err
        }

        const data = result.data as WriteResultData
        const itemRes = data.results?.[0]
        if (!itemRes) throw new Error('[Atoma] missing write item result')
        if (!itemRes.ok) throw toWriteItemError(entry.action, itemRes)

        const version = itemRes.version
        if (typeof version === 'number' && Number.isFinite(version) && version > 0) {
            const entityId = itemRes.entityId ?? entry.entityId
            if (entityId) versionUpdates.push({ key: entityId, version })
        }

        const returned = itemRes.data
        if (returned && typeof returned === 'object') {
            upserts.push(returned as T)
        }

        if (entry.intent === 'created') {
            if (returned && typeof returned === 'object') {
                created.push(returned as T)
            } else if (entry.requireCreatedData) {
                throw new Error('[Atoma] server-assigned create requires returning created results')
            }
        }
    }

    const writeback = (upserts.length || versionUpdates.length)
        ? ({
            ...(upserts.length ? { upserts } : {}),
            ...(versionUpdates.length ? { versionUpdates } : {})
        } as PersistWriteback<T>)
        : undefined

    return {
        ...(created.length ? { created } : {}),
        ...(writeback ? { writeback } : {})
    }
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

function translatePatchesToWriteOps<T extends Entity>(args: {
    pushOp: (w: { action: WriteAction; item: WriteItem; options?: WriteOptions; intent?: 'created'; requireCreatedData?: boolean }) => void
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
        args.pushOp({
            action: 'upsert',
            item,
            options: { merge: false, upsert: { mode: 'loose' } }
        })
    }
    for (const item of deleteItems) {
        args.pushOp({ action: 'delete', item })
    }
}

function toWriteItemError(action: WriteAction, result: WriteItemResult): Error {
    if (result.ok) return new Error(`[Atoma] write(${action}) failed`)
    const msg = result.error.message || 'Write failed'
    const err = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ;(err as { error?: unknown }).error = result.error
    return err
}

function findOpResult(results: Map<string, OperationResult>, opId: string): OperationResult {
    const found = results.get(opId)
    if (found) return found
    return {
        opId,
        ok: false,
        error: {
            code: 'INTERNAL',
            message: 'Missing operation result',
            kind: 'internal'
        } as StandardError
    }
}
