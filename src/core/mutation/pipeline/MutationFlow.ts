/**
 * Mutation Pipeline: Flow
 * Purpose: Executes a mutation segment (optimistic state, persistence, writeback, callbacks, rollback).
 * Call chain: Scheduler.executeSegment -> executeMutationFlow -> buildMutationProgram -> executeMutationPersistence -> finalize callbacks.
 */
import type { ObservabilityContext } from '#observability'
import type { CoreRuntime, Entity, StoreDispatchEvent } from '../../types'
import type { EntityId } from '#protocol'
import { storeWriteEngine } from '../../store/internals/storeWriteEngine'
import { buildMutationProgram } from './MutationProgram'
import { executeMutationPersistence } from './Persist'
import type { MutationCommitInfo, MutationSegment, PersistResult } from './types'
import type { StoreHandle } from '../../store/internals/handleTypes'

export async function executeMutationFlow<T extends Entity>(
    clientRuntime: CoreRuntime,
    args: MutationSegment<T>
): Promise<MutationCommitInfo | null> {
    const { handle, operations, opContext } = args
    const { atom, jotaiStore: store, indexes, storeName } = handle

    const context = createObservabilityContext(clientRuntime, handle)
    const baseState = store.get(atom)
    const fallbackClientTimeMs = resolveFallbackClientTimeMs(operations)

    const program = buildMutationProgram({
        handle,
        operations,
        currentState: baseState,
        fallbackClientTimeMs
    })

    context.emit('mutation:patches', {
        patchCount: program.patches.length,
        inversePatchCount: program.inversePatches.length
    })

    applyOptimisticState({
        store,
        atom,
        indexes,
        baseState,
        program
    })

    try {
        const persistResult = await executeMutationPersistence<T>({
            clientRuntime,
            handle,
            program,
            context
        })

        finalizeWriteback({
            store,
            atom,
            indexes,
            operations,
            persistResult
        })

        if (opContext) {
            return {
                storeName,
                opContext,
                patches: program.patches,
                inversePatches: program.inversePatches
            }
        }

        finalizeCallbacks({
            operations,
            persistResult,
            store,
            atom
        })
    } catch (error) {
        rollbackMutation({
            store,
            atom,
            indexes,
            program,
            error,
            context,
            operations
        })
    }

    return null
}

function createObservabilityContext<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>): ObservabilityContext {
    return clientRuntime.createObservabilityContext(handle.storeName)
}

function resolveFallbackClientTimeMs<T extends Entity>(operations: Array<StoreDispatchEvent<T>>): number {
    const clientTimeMs = operations.find(op => typeof op.ticket?.clientTimeMs === 'number')?.ticket?.clientTimeMs
    return typeof clientTimeMs === 'number' ? clientTimeMs : Date.now()
}

function applyOptimisticState<T extends Entity>(args: {
    store: StoreDispatchEvent<T>['handle']['jotaiStore']
    atom: StoreDispatchEvent<T>['handle']['atom']
    indexes: StoreDispatchEvent<T>['handle']['indexes']
    baseState: Map<EntityId, T>
    program: { optimisticState: Map<EntityId, T>; changedIds: ReadonlySet<EntityId> }
}) {
    if (args.program.optimisticState === args.baseState) return
    args.store.set(args.atom, args.program.optimisticState)
    if (args.program.changedIds.size) {
        args.indexes?.applyChangedIds(args.baseState, args.program.optimisticState, args.program.changedIds)
    }
}

function finalizeWriteback<T extends Entity>(args: {
    store: StoreDispatchEvent<T>['handle']['jotaiStore']
    atom: StoreDispatchEvent<T>['handle']['atom']
    indexes: StoreDispatchEvent<T>['handle']['indexes']
    operations: Array<StoreDispatchEvent<T>>
    persistResult: PersistResult<T>
}) {
    const beforeFinalize = args.store.get(args.atom) as Map<EntityId, T>
    const { nextState, changedIds } = applyPersistWriteback({
        current: beforeFinalize,
        operations: args.operations,
        persistResult: args.persistResult
    })

    if (nextState === beforeFinalize) return
    args.store.set(args.atom, nextState)
    if (changedIds.size) {
        args.indexes?.applyChangedIds(beforeFinalize, nextState, changedIds)
    }
}

function applyPersistWriteback<T extends Entity>(args: {
    current: Map<EntityId, T>
    operations: Array<StoreDispatchEvent<T>>
    persistResult: PersistResult<T>
}): { nextState: Map<EntityId, T>; changedIds: Set<EntityId> } {
    let nextState = args.current
    const changedIds = new Set<EntityId>()

    if (args.persistResult.created?.length) {
        const { next, changedIds: createdChanged } = applyCreatedWriteback({
            current: nextState,
            operations: args.operations,
            created: args.persistResult.created
        })
        nextState = next
        createdChanged.forEach(id => changedIds.add(id))
    }

    const versionUpdates = args.persistResult.writeback?.versionUpdates ?? []
    if (versionUpdates.length) {
        const { next, changedIds: versionChanged } = applyVersionWriteback({
            current: nextState,
            versionUpdates
        })
        nextState = next
        versionChanged.forEach(id => changedIds.add(id))
    }

    return { nextState, changedIds }
}

function rollbackMutation<T extends Entity>(args: {
    store: StoreDispatchEvent<T>['handle']['jotaiStore']
    atom: StoreDispatchEvent<T>['handle']['atom']
    indexes: StoreDispatchEvent<T>['handle']['indexes']
    program: { rollbackState: Map<EntityId, T>; changedIds: ReadonlySet<EntityId> }
    error: unknown
    context: ObservabilityContext
    operations: Array<StoreDispatchEvent<T>>
}) {
    const beforeRollback = args.store.get(args.atom)
    args.store.set(args.atom, args.program.rollbackState)
    if (args.program.changedIds.size) {
        args.indexes?.applyChangedIds(beforeRollback, args.program.rollbackState, args.program.changedIds)
    }
    args.context.emit('mutation:rollback', { reason: 'adapter_error' })

    const err = args.error instanceof Error ? args.error : new Error(String(args.error))
    args.operations.forEach((op) => {
        op.ticket?.settle('enqueued', err)
        op.onFail?.(err)
    })
}

function applyCreatedWriteback<T extends Entity>(args: {
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
        const value = storeWriteEngine.preserveReferenceShallow(existing, serverItem)
        if (!currentMap.has(serverId) || existing !== value) {
            if (!next) next = new Map(args.current)
            next.set(serverId, value)
            changedIds.add(serverId)
        }
    }

    return { next: next ?? args.current, changedIds }
}

function applyVersionWriteback<T extends Entity>(args: {
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
        next.set(key, storeWriteEngine.preserveReferenceShallow(curVersioned, merged))
        changedIds.add(key)
    }

    return { next: next ?? args.current, changedIds }
}

function finalizeCallbacks<T extends Entity>(args: {
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
