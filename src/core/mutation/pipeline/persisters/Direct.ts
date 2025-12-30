import type { Patch } from 'immer'
import type { ObservabilityContext } from '#observability'
import type { Entity, IDataSource, StoreDispatchEvent } from '../../../types'
import type { Persister, PersisterPersistArgs, PersisterPersistResult } from '../types'

type ApplySideEffects<T> = {
    createdResults?: T[]
}

function stableUpsertKey(op: { mode?: any; merge?: any } | undefined): string {
    const mode = op?.mode === 'loose' ? 'loose' : (op?.mode === 'strict' ? 'strict' : '')
    const merge = op?.merge === false ? '0' : (op?.merge === true ? '1' : '')
    return `${mode}|${merge}`
}

const applyPatchesViaOperations = async <T extends Entity>(
    dataSource: IDataSource<T>,
    patches: Patch[],
    appliedData: T[],
    operationTypes: StoreDispatchEvent<T>['type'][],
    operations: StoreDispatchEvent<T>[],
    internalContext?: ObservabilityContext
): Promise<ApplySideEffects<T>> => {
    if (operationTypes.length === 1 && operationTypes[0] === 'patches') {
        const putActions: T[] = []
        const deleteKeys: Array<string | number> = []

        patches.forEach(p => {
            if (p.path.length !== 1) return
            const id = p.path[0] as any
            if (p.op === 'remove') {
                deleteKeys.push(id)
                return
            }
            if (p.op === 'add' || p.op === 'replace') {
                const val = (p as any).value
                if (val && typeof val === 'object') {
                    putActions.push(val as T)
                }
            }
        })

        if (putActions.length) {
            await dataSource.bulkPut(putActions, internalContext)
        }
        if (deleteKeys.length) {
            await dataSource.bulkDelete(deleteKeys, internalContext)
        }
        return { createdResults: undefined }
    }

    const createActions: T[] = []
    const upsertActionsByKey = new Map<string, { items: T[]; options?: { mode?: any; merge?: any } }>()
    const putActions: T[] = []
    const deleteKeys: Array<string | number> = []

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
            deleteKeys.push((value as any).id as any)
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
    if (deleteKeys.length) {
        await dataSource.bulkDelete(deleteKeys, internalContext)
    }
    return {
        createdResults: Array.isArray(createdResults) ? createdResults : undefined
    }
}

export class DirectPersister implements Persister {
    async persist<T extends Entity>(args: PersisterPersistArgs<T>): Promise<PersisterPersistResult<T>> {
        const dataSource = args.handle.dataSource

        try {
            if (dataSource.applyPatches) {
                const res = await dataSource.applyPatches(
                    args.plan.patches,
                    args.metadata,
                    args.observabilityContext
                )

                const created = (res && typeof res === 'object' && Array.isArray((res as any).created))
                    ? ((res as any).created as T[])
                    : undefined

                return created && created.length ? { created } : undefined
            }

            const sideEffects = await applyPatchesViaOperations(
                dataSource,
                args.plan.patches,
                args.plan.appliedData,
                args.plan.operationTypes,
                args.operations,
                args.observabilityContext
            )

            const created = sideEffects.createdResults
            return created && created.length ? { created } : undefined
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            dataSource.onError?.(err, 'applyPatches')
            throw err
        }
    }
}
