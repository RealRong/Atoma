import type { Patch } from 'immer'
import type { ObservabilityContext } from '#observability'
import type { DeleteItem, Entity, IDataSource, StoreDispatchEvent, StoreKey } from '../../../types'
import type { Persister, PersisterPersistArgs, PersisterPersistResult } from '../types'

type ApplySideEffects<T> = {
    createdResults?: T[]
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

const applyOperations = async <T extends Entity>(
    dataSource: IDataSource<T>,
    appliedData: T[],
    operationTypes: StoreDispatchEvent<T>['type'][],
    operations: StoreDispatchEvent<T>[],
    internalContext?: ObservabilityContext
): Promise<ApplySideEffects<T>> => {
    const createActions: T[] = []
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

    if (createActions.length) {
        if (dataSource.bulkCreate) {
            const res = await dataSource.bulkCreate(createActions, internalContext)
            if (Array.isArray(res)) {
                createdResults = res
            }
        } else {
            await dataSource.bulkPut(createActions, internalContext)
        }
    }

    if (upsertActionsByKey.size) {
        for (const entry of upsertActionsByKey.values()) {
            if (!entry.items.length) continue
            if (dataSource.bulkUpsert) {
                await dataSource.bulkUpsert(entry.items, entry.options as any, internalContext)
            } else {
                await dataSource.bulkPut(entry.items, internalContext)
            }
        }
    }

    if (putActions.length) {
        await dataSource.bulkPut(putActions, internalContext)
    }
    if (deleteItems.length) {
        await dataSource.bulkDelete(deleteItems, internalContext)
    }
    return {
        createdResults: Array.isArray(createdResults) ? createdResults : undefined
    }
}

const persistPatchesByRestoreReplace = async <T extends Entity>(args: {
    dataSource: IDataSource<T>
    plan: { patches: Patch[]; inversePatches: Patch[]; nextState: Map<StoreKey, T> }
    internalContext?: ObservabilityContext
}): Promise<void> => {
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

    if (upserts.length) {
        if (!dataSource.bulkUpsert) {
            throw new Error('[Atoma] restore/replace requires dataSource.bulkUpsert')
        }
        await dataSource.bulkUpsert(upserts, { mode: 'loose', merge: false }, internalContext)
    }
    if (deletes.length) {
        await dataSource.bulkDelete(deletes, internalContext)
    }
}

export class DirectPersister implements Persister {
    async persist<T extends Entity>(args: PersisterPersistArgs<T>): Promise<PersisterPersistResult<T>> {
        const dataSource = args.handle.dataSource

        try {
            if (args.plan.operationTypes.length === 1 && args.plan.operationTypes[0] === 'patches') {
                await persistPatchesByRestoreReplace({
                    dataSource,
                    plan: args.plan as any,
                    internalContext: args.observabilityContext
                })
                return
            }

            const sideEffects = await applyOperations(
                dataSource,
                args.plan.appliedData,
                args.plan.operationTypes,
                args.operations,
                args.observabilityContext
            )

            const created = sideEffects.createdResults
            return created && created.length ? { created } : undefined
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            dataSource.onError?.(err, 'persist')
            throw err
        }
    }
}
