import type { Patch } from 'immer'
import type { ObservabilityContext } from '#observability'
import type { Entity, IAdapter, StoreDispatchEvent } from '../../../types'
import type { Persister, PersisterPersistArgs, PersisterPersistResult } from '../types'

type ApplySideEffects<T> = {
    createdResults?: T[]
}

const applyPatchesViaOperations = async <T extends Entity>(
    adapter: IAdapter<T>,
    patches: Patch[],
    appliedData: T[],
    operationTypes: StoreDispatchEvent<T>['type'][],
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
            await adapter.bulkPut(putActions, internalContext)
        }
        if (deleteKeys.length) {
            await adapter.bulkDelete(deleteKeys, internalContext)
        }
        return { createdResults: undefined }
    }

    const createActions: T[] = []
    const putActions: T[] = []
    const deleteKeys: Array<string | number> = []

    operationTypes.forEach((type, idx) => {
        const value = appliedData[idx]
        if (!value) return
        if (type === 'add') {
            createActions.push(value)
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
        if (adapter.bulkCreate) {
            const res = await adapter.bulkCreate(createActions, internalContext)
            if (Array.isArray(res)) {
                createdResults = res
            }
        } else {
            await adapter.bulkPut(createActions, internalContext)
        }
    }

    if (putActions.length) {
        await adapter.bulkPut(putActions, internalContext)
    }
    if (deleteKeys.length) {
        await adapter.bulkDelete(deleteKeys, internalContext)
    }
    return {
        createdResults: Array.isArray(createdResults) ? createdResults : undefined
    }
}

export class DirectPersister implements Persister {
    async persist<T extends Entity>(args: PersisterPersistArgs<T>): Promise<PersisterPersistResult<T>> {
        const adapter = args.handle.adapter

        try {
            if (adapter.applyPatches) {
                const res = await adapter.applyPatches(
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
                adapter,
                args.plan.patches,
                args.plan.appliedData,
                args.plan.operationTypes,
                args.observabilityContext
            )

            const created = sideEffects.createdResults
            return created && created.length ? { created } : undefined
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            adapter.onError?.(err, 'applyPatches')
            throw err
        }
    }
}
