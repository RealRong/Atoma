import type { Patch } from 'immer'
import type { ObservabilityContext } from '#observability'
import type { DeleteItem, Entity, IDataSource, PersistWriteback, StoreDispatchEvent, StoreKey } from '../../../types'
import type { Persister, PersisterPersistArgs, PersisterPersistResult } from '../types'

type ApplySideEffects<T extends Entity> = {
    createdResults?: T[]
    writeback?: PersistWriteback<T>
}

function isStoreKey(v: unknown): v is StoreKey {
    return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
}

function requireBaseVersion(id: StoreKey, value: unknown): number {
    const v = value && typeof value === 'object' ? (value as any).version : undefined
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    throw new Error(`[Atoma] delete requires baseVersion (missing version for id=${String(id)})`)
}

function stableUpsertKey(op: { mode?: any; merge?: any } | undefined): string {
    const mode = op?.mode === 'loose' ? 'loose' : (op?.mode === 'strict' ? 'strict' : '')
    const merge = op?.merge === false ? '0' : (op?.merge === true ? '1' : '')
    return `${mode}|${merge}`
}

function mergeWriteback<T extends Entity>(
    base: PersistWriteback<T> | undefined,
    next: PersistWriteback<T> | void | undefined
): PersistWriteback<T> | undefined {
    if (!next) return base

    const nextUpserts = next.upserts ?? []
    const nextDeletes = next.deletes ?? []
    const nextVersionUpdates = next.versionUpdates ?? []

    if (!base) {
        if (!nextUpserts.length && !nextDeletes.length && !nextVersionUpdates.length) return
        return next as PersistWriteback<T>
    }

    const merged: PersistWriteback<T> = {}
    const upserts = (base.upserts ?? []).concat(nextUpserts)
    const deletes = (base.deletes ?? []).concat(nextDeletes)
    const versionUpdates = (base.versionUpdates ?? []).concat(nextVersionUpdates)

    if (upserts.length) (merged as any).upserts = upserts
    if (deletes.length) (merged as any).deletes = deletes
    if (versionUpdates.length) (merged as any).versionUpdates = versionUpdates
    return merged
}

const applyOperations = async <T extends Entity>(
    dataSource: IDataSource<T>,
    appliedData: any[],
    operationTypes: StoreDispatchEvent<T>['type'][],
    operations: StoreDispatchEvent<T>[],
    internalContext?: ObservabilityContext
): Promise<ApplySideEffects<T>> => {
    const createActions: T[] = []
    const createServerAssignedActions: any[] = []
    const upsertActionsByKey = new Map<string, { items: T[]; options?: { mode?: any; merge?: any } }>()
    const putActions: T[] = []
    const deleteItems: DeleteItem[] = []

    operationTypes.forEach((type, idx) => {
        const value = appliedData[idx]
        if (!value) return
        if (type === 'add') {
            createActions.push(value)
            return
        }
        if (type === 'create') {
            createServerAssignedActions.push(value)
            return
        }
        if (type === 'upsert') {
            const op = operations[idx]
            const upsert = (op && op.type === 'upsert') ? (op as any).upsert : undefined
            const key = stableUpsertKey(upsert)
            const entry = upsertActionsByKey.get(key) ?? (() => {
                const next = { items: [] as T[], options: upsert }
                upsertActionsByKey.set(key, next)
                return next
            })()
            entry.items.push(value)
            return
        }
        if (type === 'update' || type === 'remove') {
            putActions.push(value)
            return
        }
        if (type === 'forceRemove') {
            const id = (value as any)?.id
            if (!isStoreKey(id)) return
            const baseVersion = requireBaseVersion(id, value)
            deleteItems.push({ id, baseVersion })
        }
    })

    let createdResults: T[] | undefined
    let writeback: PersistWriteback<T> | undefined

    if (createActions.length) {
        if (dataSource.bulkCreate) {
            const res = await dataSource.bulkCreate(createActions, internalContext)
            if (Array.isArray(res)) {
                for (let i = 0; i < res.length; i++) {
                    const created: any = res[i]
                    const original: any = createActions[i]
                    if (!created || !original) continue
                    const createdId = (created as any).id
                    const originalId = (original as any).id
                    if (createdId !== undefined && originalId !== undefined && createdId !== originalId) {
                        throw new Error(`[Atoma] bulkCreate returned mismatched id (expected=${String(originalId)}, actual=${String(createdId)})`)
                    }
                }
                createdResults = res
            }
        } else {
            await dataSource.bulkPut(createActions, internalContext)
        }
    }

    if (createServerAssignedActions.length) {
        const dsAny: any = dataSource as any
        if (typeof dsAny.bulkCreateServerAssigned !== 'function') {
            throw new Error('[Atoma] server-assigned create requires dataSource.bulkCreateServerAssigned')
        }
        const res = await dsAny.bulkCreateServerAssigned(createServerAssignedActions, internalContext)
        if (!Array.isArray(res) || !res.length) {
            throw new Error('[Atoma] server-assigned create requires returning created results')
        }
        createdResults = Array.isArray(createdResults)
            ? createdResults.concat(res as T[])
            : (res as T[])
    }

    if (upsertActionsByKey.size) {
        const dsAny: any = dataSource as any
        for (const entry of upsertActionsByKey.values()) {
            if (!entry.items.length) continue
            if (typeof dsAny.bulkUpsertReturning === 'function') {
                const wb = await dsAny.bulkUpsertReturning(entry.items, entry.options as any, internalContext)
                writeback = mergeWriteback(writeback, wb)
            } else if (dataSource.bulkUpsert) {
                await dataSource.bulkUpsert(entry.items, entry.options as any, internalContext)
            } else {
                await dataSource.bulkPut(entry.items, internalContext)
            }
        }
    }

    if (putActions.length) {
        const dsAny: any = dataSource as any
        if (typeof dsAny.bulkPutReturning === 'function') {
            const wb = await dsAny.bulkPutReturning(putActions, internalContext)
            writeback = mergeWriteback(writeback, wb)
        } else {
            await dataSource.bulkPut(putActions, internalContext)
        }
    }
    if (deleteItems.length) {
        const dsAny: any = dataSource as any
        if (typeof dsAny.bulkDeleteReturning === 'function') {
            const wb = await dsAny.bulkDeleteReturning(deleteItems, internalContext)
            writeback = mergeWriteback(writeback, wb)
        } else {
            await dataSource.bulkDelete(deleteItems, internalContext)
        }
    }
    return {
        createdResults: Array.isArray(createdResults) ? createdResults : undefined,
        writeback
    }
}

const persistPatchesByRestoreReplace = async <T extends Entity>(args: {
    dataSource: IDataSource<T>
    plan: { patches: Patch[]; inversePatches: Patch[]; nextState: Map<StoreKey, T> }
    internalContext?: ObservabilityContext
}): Promise<PersistWriteback<T> | void> => {
    const { dataSource, plan, internalContext } = args

    const touchedIds = new Set<StoreKey>()
    plan.patches.forEach(p => {
        const root = (p as any)?.path?.[0]
        if (isStoreKey(root)) touchedIds.add(root)
    })

    if (touchedIds.size === 0) return

    const baseVersionByDeletedId = new Map<StoreKey, number>()
    plan.inversePatches.forEach(p => {
        if (p.op !== 'add') return
        if (!Array.isArray((p as any).path) || (p as any).path.length !== 1) return
        const id = (p as any).path[0]
        if (!isStoreKey(id)) return
        const value = (p as any).value
        const baseVersion = requireBaseVersion(id, value)
        baseVersionByDeletedId.set(id, baseVersion)
    })

    const upserts: T[] = []
    const deletes: DeleteItem[] = []

    for (const id of touchedIds.values()) {
        if (plan.nextState.has(id)) {
            const value = plan.nextState.get(id)
            if (value) upserts.push(value)
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }
        deletes.push({ id, baseVersion })
    }

    let writeback: PersistWriteback<T> | undefined

    if (upserts.length) {
        const dsAny: any = dataSource as any
        if (typeof dsAny.bulkUpsertReturning === 'function') {
            const wb = await dsAny.bulkUpsertReturning(upserts, { mode: 'loose', merge: false }, internalContext)
            writeback = mergeWriteback(writeback, wb)
        } else {
            if (!dataSource.bulkUpsert) {
                throw new Error('[Atoma] restore/replace requires dataSource.bulkUpsert')
            }
            await dataSource.bulkUpsert(upserts, { mode: 'loose', merge: false }, internalContext)
        }
    }
    if (deletes.length) {
        const dsAny: any = dataSource as any
        if (typeof dsAny.bulkDeleteReturning === 'function') {
            const wb = await dsAny.bulkDeleteReturning(deletes, internalContext)
            writeback = mergeWriteback(writeback, wb)
        } else {
            await dataSource.bulkDelete(deletes, internalContext)
        }
    }

    return writeback
}

export class DirectPersister implements Persister {
    async persist<T extends Entity>(args: PersisterPersistArgs<T>): Promise<PersisterPersistResult<T>> {
        const dataSource = args.handle.dataSource

        try {
            if (args.plan.operationTypes.length === 1 && args.plan.operationTypes[0] === 'patches') {
                const writeback = await persistPatchesByRestoreReplace({
                    dataSource,
                    plan: args.plan as any,
                    internalContext: args.observabilityContext
                })
                return writeback ? { writeback } : undefined
            }

            const sideEffects = await applyOperations(
                dataSource,
                args.plan.appliedData,
                args.plan.operationTypes,
                args.operations,
                args.observabilityContext
            )

            const created = sideEffects.createdResults
            const writeback = sideEffects.writeback

            const out: any = {}
            if (created && created.length) out.created = created
            if (writeback) out.writeback = writeback
            return Object.keys(out).length ? out : undefined
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            dataSource.onError?.(err, 'persist')
            throw err
        }
    }
}
