import { PrimitiveAtom } from 'jotai'
import { applyPatches, Patch } from 'immer'
import { ApplyResult } from './OperationApplier'
import { IAdapter, PatchMetadata } from '../types'
import { AtomVersionTracker } from '../state/AtomVersionTracker'
import { HistoryRecorder } from '../history/HistoryRecorder'

type CallbackEntry = { onSuccess?: (...args: any[]) => void, onFail?: (error?: Error) => void }

interface SyncParams<T> {
    adapter: IAdapter<T>
    applyResult: ApplyResult<T>
    atom: PrimitiveAtom<Map<any, any>>
    callbacks: CallbackEntry[]
    store: any
    versionTracker: AtomVersionTracker
    historyRecorder: HistoryRecorder
    mode: 'optimistic' | 'strict'
}

const applyPatchesViaOperations = async <T>(adapter: IAdapter<T>, patches: Patch[]) => {
    const putActions: T[] = []
    const deleteKeys: Array<string | number> = []

    patches.forEach(patch => {
        if (patch.op === 'add' || patch.op === 'replace') {
            putActions.push(patch.value as T)
        } else if (patch.op === 'remove') {
            deleteKeys.push(patch.path[0] as any)
        }
    })

    if (putActions.length) {
        await adapter.bulkPut(putActions)
    }
    if (deleteKeys.length) {
        await adapter.bulkDelete(deleteKeys)
    }
}

export class AdapterSync {
    async syncAtom<T>(params: SyncParams<T>): Promise<void> {
        const { adapter, applyResult, atom, callbacks, store, versionTracker, historyRecorder, mode } = params
        const { newValue, patches, inversePatches, changedFields } = applyResult
        const originalValue = store.get(atom)

        const metadata: PatchMetadata = {
            atom,
            databaseName: adapter.name,
            timestamp: Date.now(),
            baseVersion: Date.now()
        }

        // Optimistic: apply immediately
        if (mode === 'optimistic') {
            store.set(atom, newValue)
            versionTracker.bump(atom, changedFields)
            callbacks.forEach(({ onSuccess }) => setTimeout(() => onSuccess?.(), 0))
        }

        try {
            if (adapter.applyPatches) {
                await adapter.applyPatches(patches, metadata)
            } else {
                await applyPatchesViaOperations(adapter, patches)
            }

            if (mode === 'strict') {
                // apply after adapter success
                const currentValue = store.get(atom)
                const latest = applyPatches(currentValue, patches)
                store.set(atom, latest)
                versionTracker.bump(atom, changedFields)
                callbacks.forEach(({ onSuccess }) => setTimeout(() => onSuccess?.(), 0))
            }

            // Record history only on success
            historyRecorder.record({ patches, inversePatches, atom, adapter })
        } catch (error) {
            adapter.onError?.(error as Error, 'applyPatches')

            if (mode === 'optimistic') {
                // rollback
                store.set(atom, originalValue)
            }
            const err = error instanceof Error ? error : new Error(String(error))
            callbacks.forEach(({ onFail }) => setTimeout(() => onFail?.(err), 0))
        }
    }
}
