/**
 * Mutation Pipeline: Flow
 * Purpose: Executes a mutation segment (optimistic state, persistence, server ack, callbacks, rollback).
 * Call chain: Scheduler.executeSegment -> executeMutationFlow -> buildMutationProgram -> executeMutationPersistence -> finalize callbacks.
 */
import type { ObservabilityContext } from '#observability'
import type { CoreRuntime, Entity, StoreDispatchEvent } from '../../types'
import type { EntityId } from '#protocol'
import { storeWriteEngine } from '../../store/internals/storeWriteEngine'
import { buildMutationProgram } from './MutationProgram'
import { executeMutationPersistence } from './Persist'
import type { StoreCommit, MutationSegment, PersistResult, TranslatedWriteOp } from './types'
import type { StoreHandle } from '../../store/internals/handleTypes'

export async function executeMutationFlow<T extends Entity>(
    clientRuntime: CoreRuntime,
    args: MutationSegment<T>
): Promise<StoreCommit | null> {
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
        applyLocalVersionUpdates({
            store,
            atom,
            indexes,
            program
        })

        const persistResult = await executeMutationPersistence<T>({
            clientRuntime,
            handle,
            program,
            context
        })

        finalizeAckWriteback({
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
    return clientRuntime.observability.createContext(handle.storeName)
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

function applyLocalVersionUpdates<T extends Entity>(args: {
    store: StoreDispatchEvent<T>['handle']['jotaiStore']
    atom: StoreDispatchEvent<T>['handle']['atom']
    indexes: StoreDispatchEvent<T>['handle']['indexes']
    program: { writeOps: Array<TranslatedWriteOp> }
}) {
    if (!args.program.writeOps.length) return

    const before = args.store.get(args.atom) as Map<EntityId, T>
    const versionUpdates = collectLocalVersionUpdates({
        current: before,
        writeOps: args.program.writeOps
    })
    if (!versionUpdates.length) return

    const { next, changedIds } = applyVersionWriteback({
        current: before,
        versionUpdates
    })

    if (next === before) return
    args.store.set(args.atom, next)
    if (changedIds.size) {
        args.indexes?.applyChangedIds(before, next, changedIds)
    }
}

function finalizeAckWriteback<T extends Entity>(args: {
    store: StoreDispatchEvent<T>['handle']['jotaiStore']
    atom: StoreDispatchEvent<T>['handle']['atom']
    indexes: StoreDispatchEvent<T>['handle']['indexes']
    operations: Array<StoreDispatchEvent<T>>
    persistResult: PersistResult<T>
}) {
    const beforeFinalize = args.store.get(args.atom) as Map<EntityId, T>
    const { nextState, changedIds } = applyPersistAck({
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

function applyPersistAck<T extends Entity>(args: {
    current: Map<EntityId, T>
    operations: Array<StoreDispatchEvent<T>>
    persistResult: PersistResult<T>
}): { nextState: Map<EntityId, T>; changedIds: Set<EntityId> } {
    let nextState = args.current
    const changedIds = new Set<EntityId>()

    const ack = args.persistResult.ack
    if (ack?.created?.length) {
        const { next, changedIds: createdChanged } = applyCreatedWriteback({
            current: nextState,
            operations: args.operations,
            created: ack.created
        })
        nextState = next
        createdChanged.forEach(id => changedIds.add(id))
    }

    if (ack?.upserts?.length) {
        const { next, changedIds: upsertChanged } = applyUpsertsWriteback({
            current: nextState,
            upserts: ack.upserts
        })
        nextState = next
        upsertChanged.forEach(id => changedIds.add(id))
    }

    if (ack?.deletes?.length) {
        const { next, changedIds: deleteChanged } = applyDeletesWriteback({
            current: nextState,
            deletes: ack.deletes
        })
        nextState = next
        deleteChanged.forEach(id => changedIds.add(id))
    }

    const versionUpdates = ack?.versionUpdates ?? []
    if (versionUpdates.length) {
        const skip = new Set<EntityId>()
        if (ack?.upserts?.length) {
            for (const item of ack.upserts) {
                const id = (item as any)?.id
                if (id) skip.add(id)
            }
        }
        if (ack?.created?.length) {
            for (const item of ack.created) {
                const id = (item as any)?.id
                if (id) skip.add(id)
            }
        }
        const filtered = skip.size
            ? versionUpdates.filter(v => v && !skip.has(v.key))
            : versionUpdates

        if (filtered.length) {
            const { next, changedIds: versionChanged } = applyVersionWriteback({
                current: nextState,
                versionUpdates: filtered
            })
            nextState = next
            versionChanged.forEach(id => changedIds.add(id))
        }
    }

    return { nextState, changedIds }
}

function applyUpsertsWriteback<T extends Entity>(args: {
    current: Map<EntityId, T>
    upserts: T[]
}): { next: Map<EntityId, T>; changedIds: Set<EntityId> } {
    let next: Map<EntityId, T> | null = null
    const changedIds = new Set<EntityId>()

    for (const item of args.upserts) {
        if (!item || typeof item !== 'object') continue
        const id = (item as any).id as EntityId
        if (!id) continue

        const mapRef = next ?? args.current
        const existing = mapRef.get(id)
        const existed = mapRef.has(id)
        const preserved = existing ? storeWriteEngine.preserveReferenceShallow(existing, item) : item
        if (existed && existing === preserved) continue

        if (!next) next = new Map(args.current)
        next.set(id, preserved)
        changedIds.add(id)
    }

    return { next: next ?? args.current, changedIds }
}

function applyDeletesWriteback<T extends Entity>(args: {
    current: Map<EntityId, T>
    deletes: EntityId[]
}): { next: Map<EntityId, T>; changedIds: Set<EntityId> } {
    let next: Map<EntityId, T> | null = null
    const changedIds = new Set<EntityId>()

    for (const id of args.deletes) {
        const mapRef = next ?? args.current
        if (!mapRef.has(id)) continue
        if (!next) next = new Map(args.current)
        next.delete(id)
        changedIds.add(id)
    }

    return { next: next ?? args.current, changedIds }
}

function collectLocalVersionUpdates<T extends Entity>(args: {
    current: Map<EntityId, T>
    writeOps: Array<TranslatedWriteOp>
}): Array<{ key: EntityId; version: number }> {
    const updates: Array<{ key: EntityId; version: number }> = []

    for (const entry of args.writeOps) {
        const op: any = entry.op
        if (!op || op.kind !== 'write') continue

        const write: any = op.write
        const items = Array.isArray(write?.items) ? write.items : []
        const options = (write?.options && typeof write.options === 'object') ? write.options : undefined
        const upsertMode: 'strict' | 'loose' = options?.upsert?.mode === 'loose' ? 'loose' : 'strict'

        for (const item of items) {
            const entityId = resolveEntityId(item)
            if (!entityId) {
                throw new Error('[Atoma] local version: 缺少 entityId')
            }

            const currentVersion = resolvePositiveVersion(args.current.get(entityId))

            if (entry.action === 'create') {
                const valueVersion = resolvePositiveVersion((item as any)?.value)
                updates.push({ key: entityId, version: valueVersion ?? 1 })
                continue
            }

            if (entry.action === 'update') {
                const baseVersion = (item as any)?.baseVersion
                if (!isPositiveVersion(baseVersion)) {
                    throw new Error(`[Atoma] local version: update 缺少 baseVersion（id=${String(entityId)})`)
                }
                if (isPositiveVersion(currentVersion) && currentVersion !== baseVersion) {
                    throw new Error(`[Atoma] local version: update 版本冲突（id=${String(entityId)})`)
                }
                updates.push({ key: entityId, version: baseVersion + 1 })
                continue
            }

            if (entry.action === 'upsert') {
                const baseVersion = (item as any)?.baseVersion
                if (upsertMode === 'strict' && !isPositiveVersion(baseVersion) && isPositiveVersion(currentVersion)) {
                    throw new Error(`[Atoma] local version: strict upsert 缺少 baseVersion（id=${String(entityId)})`)
                }
                if (isPositiveVersion(baseVersion) && isPositiveVersion(currentVersion) && currentVersion !== baseVersion) {
                    throw new Error(`[Atoma] local version: upsert 版本冲突（id=${String(entityId)})`)
                }
                const nextVersion = isPositiveVersion(baseVersion)
                    ? baseVersion + 1
                    : (isPositiveVersion(currentVersion) ? currentVersion + 1 : 1)
                updates.push({ key: entityId, version: nextVersion })
                continue
            }

            if (entry.action === 'delete') {
                const baseVersion = (item as any)?.baseVersion
                if (!isPositiveVersion(baseVersion)) {
                    throw new Error(`[Atoma] local version: delete 缺少 baseVersion（id=${String(entityId)})`)
                }
                if (isPositiveVersion(currentVersion) && currentVersion !== baseVersion) {
                    throw new Error(`[Atoma] local version: delete 版本冲突（id=${String(entityId)})`)
                }
                updates.push({ key: entityId, version: baseVersion + 1 })
            }
        }
    }

    return updates
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
        if (op.type !== 'add') continue
        const serverItem = args.created[cursor++]
        if (!serverItem || typeof serverItem !== 'object') continue

        const serverId = serverItem.id
        if (serverId === undefined || serverId === null) continue

        const tempId = op.data.id
        if (tempId !== undefined && tempId !== null && tempId !== serverId && args.current.has(tempId)) {
            if (!next) next = new Map(args.current)
            next.delete(tempId)
            changedIds.add(tempId)
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

function resolveEntityId(item: unknown): EntityId | undefined {
    if (!item || typeof item !== 'object') return undefined
    const entityId = (item as any).entityId
    if (typeof entityId === 'string' && entityId) return entityId
    const value = (item as any).value
    if (value && typeof value === 'object') {
        const id = (value as any).id
        if (typeof id === 'string' && id) return id as EntityId
    }
    return undefined
}

function resolvePositiveVersion(value: unknown): number | undefined {
    const v = value && typeof value === 'object' ? (value as any).version : undefined
    return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : undefined
}

function isPositiveVersion(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function finalizeCallbacks<T extends Entity>(args: {
    operations: Array<StoreDispatchEvent<T>>
    persistResult: PersistResult<T>
    store: StoreDispatchEvent<T>['handle']['jotaiStore']
    atom: StoreDispatchEvent<T>['handle']['atom']
}) {
    let createdCursor = 0
    const created = args.persistResult.ack?.created ?? []
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
