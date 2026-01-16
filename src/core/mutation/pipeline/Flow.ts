import type { Entity, StoreDispatchEvent } from '../../types'
import type { EntityId } from '#protocol'
import { preserveReferenceShallow } from '../../store/internals/preserveReference'
import { compileMutationProgram } from './Program'
import { persistMutation } from './Persist'
import type { MutationCommitInfo, MutationSegment, PersistResult } from './types'

export async function runMutationFlow<T extends Entity>(args: MutationSegment<T>): Promise<MutationCommitInfo | null> {
    const {
        handle,
        operations,
        opContext
    } = args

    const { atom, jotaiStore: store, indexes, storeName } = handle

    const ctx = handle.createObservabilityContext
        ? handle.createObservabilityContext()
        : handle.observability.createContext()

    const originalState = store.get(atom)

    const clientTimeMs = operations.find(op => typeof op.ticket?.clientTimeMs === 'number')?.ticket?.clientTimeMs
    const timestamp = typeof clientTimeMs === 'number' ? clientTimeMs : Date.now()

    const program = compileMutationProgram({
        handle,
        operations,
        currentState: originalState,
        fallbackClientTimeMs: timestamp
    })

    ctx.emit('mutation:patches', {
        patchCount: program.patches.length,
        inversePatchCount: program.inversePatches.length
    })

    if (program.optimisticState !== originalState) {
        store.set(atom, program.optimisticState)
        if (program.changedIds.size) {
            indexes?.applyChangedIds(originalState, program.optimisticState, program.changedIds)
        }
    }

    try {
        const persistResult: PersistResult<T> = await persistMutation({
            handle,
            program,
            context: ctx
        })

        const beforeFinalize = store.get(atom) as Map<EntityId, T>
        let nextState = beforeFinalize
        const changedIdsForFinalize = new Set<EntityId>()

        if (persistResult.created?.length) {
            const { next, changedIds } = applyCreatedResults({
                current: nextState,
                operations,
                created: persistResult.created
            })
            nextState = next
            changedIds.forEach(id => changedIdsForFinalize.add(id))
        }

        const versionUpdates = persistResult.writeback?.versionUpdates ?? []
        if (versionUpdates.length) {
            const { next, changedIds } = applyVersionUpdates({
                current: nextState,
                versionUpdates
            })
            nextState = next
            changedIds.forEach(id => changedIdsForFinalize.add(id))
        }

        if (nextState !== beforeFinalize) {
            store.set(atom, nextState)
            if (changedIdsForFinalize.size) {
                indexes?.applyChangedIds(beforeFinalize, nextState, changedIdsForFinalize)
            }
        }

        if (opContext) {
            return {
                storeName,
                opContext,
                patches: program.patches,
                inversePatches: program.inversePatches
            }
        }

        settleAndCallbacks({
            operations,
            persistResult,
            store,
            atom
        })
    } catch (error) {
        const beforeRollback = store.get(atom)
        store.set(atom, program.rollbackState)
        if (program.changedIds.size) {
            indexes?.applyChangedIds(beforeRollback, program.rollbackState, program.changedIds)
        }
        ctx.emit('mutation:rollback', { reason: 'adapter_error' })

        const err = error instanceof Error ? error : new Error(String(error))
        operations.forEach((op) => {
            op.ticket?.settle('enqueued', err)
            op.onFail?.(err)
        })
    }

    return null
}

function applyCreatedResults<T extends Entity>(args: {
    current: Map<EntityId, T>
    operations: Array<StoreDispatchEvent<T>>
    created: T[]
}): { next: Map<EntityId, T>; changedIds: Set<EntityId> } {
    let next: Map<EntityId, T> | null = null
    const changedIds = new Set<EntityId>()
    let cursor = 0

    for (const op of args.operations) {
        if (op.type !== 'add' && op.type !== 'create') continue
        const serverItem = args.created[cursor++]
        if (!serverItem || typeof serverItem !== 'object') continue

        const serverId = serverItem.id
        if (serverId === undefined || serverId === null) continue

        if (op.type === 'add') {
            const tempId = op.data.id
            if (tempId !== undefined && tempId !== null && tempId !== serverId && args.current.has(tempId)) {
                if (!next) next = new Map(args.current)
                next.delete(tempId)
                changedIds.add(tempId)
            }
        }

        const currentMap = next ?? args.current
        const existing = currentMap.get(serverId)
        const value = preserveReferenceShallow(existing, serverItem)
        if (!currentMap.has(serverId) || existing !== value) {
            if (!next) next = new Map(args.current)
            next.set(serverId, value)
            changedIds.add(serverId)
        }
    }

    return { next: next ?? args.current, changedIds }
}

function applyVersionUpdates<T extends Entity>(args: {
    current: Map<EntityId, T>
    versionUpdates: Array<{ key: EntityId; version: number }>
}): { next: Map<EntityId, T>; changedIds: Set<EntityId> } {
    const versionByKey = new Map<EntityId, number>()
    for (const v of args.versionUpdates) {
        if (!v) continue
        if (typeof v.version !== 'number' || !Number.isFinite(v.version) || v.version <= 0) continue
        versionByKey.set(v.key, v.version)
    }
    if (!versionByKey.size) return { next: args.current, changedIds: new Set() }

    let next: Map<EntityId, T> | null = null
    const changedIds = new Set<EntityId>()

    for (const [key, version] of versionByKey.entries()) {
        const cur = (next ?? args.current).get(key)
        if (!cur || typeof cur !== 'object') continue
        const curVersioned = cur as T & { version?: number }
        if (curVersioned.version === version) continue
        if (!next) next = new Map(args.current)
        const merged = { ...curVersioned, version }
        next.set(key, preserveReferenceShallow(curVersioned, merged))
        changedIds.add(key)
    }

    return { next: next ?? args.current, changedIds }
}

function settleAndCallbacks<T extends Entity>(args: {
    operations: Array<StoreDispatchEvent<T>>
    persistResult: PersistResult<T>
    store: StoreDispatchEvent<T>['handle']['jotaiStore']
    atom: StoreDispatchEvent<T>['handle']['atom']
}) {
    let createdCursor = 0
    const created = args.persistResult.created ?? []
    const current = args.store.get(args.atom) as Map<EntityId, T>

    for (const op of args.operations) {
        op.ticket?.settle('enqueued')
        if (args.persistResult.status === 'confirmed') {
            op.ticket?.settle('confirmed')
        }

        if (op.type === 'add') {
            const payload = (args.persistResult.status === 'confirmed' && created[createdCursor])
                ? created[createdCursor++]
                : (current.get(op.data.id) ?? (op.data as unknown as T))
            op.onSuccess?.(payload)
            continue
        }

        if (op.type === 'create') {
            const payload = created[createdCursor++]
            op.onSuccess?.(payload)
            continue
        }

        if (op.type === 'update' || op.type === 'upsert') {
            const payload = current.get(op.data.id) ?? (op.data as unknown as T)
            op.onSuccess?.(payload)
            continue
        }

        if ('onSuccess' in op) {
            const cb = op.onSuccess
            if (typeof cb === 'function') cb()
        }
    }
}
