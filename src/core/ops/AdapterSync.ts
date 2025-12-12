import { PrimitiveAtom } from 'jotai'
import { applyPatches, Patch } from 'immer'
import { ApplyResult } from './OperationApplier'
import { IAdapter, PatchMetadata, Entity, StoreDispatchEvent } from '../types'
import { AtomVersionTracker } from '../state/AtomVersionTracker'
import { HistoryRecorder } from '../history/HistoryRecorder'

type CallbackEntry = { onSuccess?: (...args: any[]) => void, onFail?: (error?: Error) => void }

interface SyncParams<T extends Entity> {
    adapter: IAdapter<T>
    applyResult: ApplyResult<T>
    atom: PrimitiveAtom<Map<any, any>>
    callbacks: CallbackEntry[]
    store: any
    versionTracker: AtomVersionTracker
    historyRecorder: HistoryRecorder
    mode: 'optimistic' | 'strict'
}

type ApplySideEffects<T> = {
    createdResults?: T[]
}

const applyPatchesViaOperations = async <T extends Entity>(
    adapter: IAdapter<T>,
    patches: Patch[],
    _appliedData: T[],
    _operationTypes: StoreDispatchEvent<T>['type'][]
): Promise<ApplySideEffects<T>> => {
    const createActions: T[] = []
    const putActions: T[] = []
    const deleteKeys: Array<string | number> = []

    patches.forEach(patch => {
        if (patch.op === 'add' || patch.op === 'replace') {
            // Immer on Map: op 'add' => new key, 'replace' => existing key update
            const value = patch.value as T
            if (patch.op === 'add') {
                createActions.push(value)
            } else {
                putActions.push(value)
            }
        } else if (patch.op === 'remove') {
            deleteKeys.push(patch.path[0] as any)
        }
    })

    let createdResults: T[] | void

    if (createActions.length) {
        if (adapter.bulkCreate) {
            createdResults = await adapter.bulkCreate(createActions)
        } else {
            await adapter.bulkPut(createActions)
        }
    }

    if (putActions.length) {
        await adapter.bulkPut(putActions)
    }
    if (deleteKeys.length) {
        await adapter.bulkDelete(deleteKeys)
    }
    return {
        createdResults: Array.isArray(createdResults) ? createdResults : undefined
    }
}

export class AdapterSync {
    async syncAtom<T extends Entity>(params: SyncParams<T>): Promise<void> {
        const { adapter, applyResult, atom, callbacks, store, versionTracker, historyRecorder, mode } = params
        const { newValue, patches, inversePatches, changedFields } = applyResult
        const originalValue = store.get(atom)

        const metadata: PatchMetadata = {
            atom,
            databaseName: adapter.name,
            timestamp: Date.now(),
            baseVersion: Date.now()
        }

        // Optimistic: apply到本地，但不立即触发 onSuccess，待适配器确认后再回调
        if (mode === 'optimistic') {
            store.set(atom, newValue)
            versionTracker.bump(atom, changedFields)
        }

        let sideEffects: ApplySideEffects<T> | undefined

        try {
            if (adapter.applyPatches) {
                const res = await adapter.applyPatches(patches, metadata)
                if (res && typeof res === 'object' && Array.isArray((res as any).created)) {
                    sideEffects = { createdResults: (res as any).created as T[] }
                }
            } else {
                sideEffects = await applyPatchesViaOperations(adapter, patches, applyResult.appliedData, applyResult.operationTypes)
            }

            // Apply patches & reconcile server返回ID（尤其 create）
            const rewriteCreated = (created?: T[]) => {
                if (!created || !created.length) return
                const current = store.get(atom)
                const next = new Map(current)
                let addCursor = 0

                applyResult.operationTypes.forEach((type, idx) => {
                    if (type !== 'add') return
                    const temp = applyResult.appliedData[idx]
                    const serverItem = created[addCursor++] ?? temp
                    const tempId = (temp as any)?.id
                    if (tempId !== undefined) {
                        next.delete(tempId)
                    }
                    const serverId = (serverItem as any)?.id
                    if (serverId !== undefined) {
                        next.set(serverId, serverItem as any)
                    }
                    applyResult.appliedData[idx] = serverItem
                })

                store.set(atom, next)
                versionTracker.bump(atom, new Set(['id']))
            }

            if (mode === 'strict') {
                const currentValue = store.get(atom)
                let latest = applyPatches(currentValue, patches)
                // 在严格模式下，如果服务端返回了真实 ID，优先替换
                if (sideEffects?.createdResults?.length) {
                    const map = new Map(latest)
                    let addCursor = 0
                    applyResult.operationTypes.forEach((type, idx) => {
                        if (type !== 'add') return
                        const temp = applyResult.appliedData[idx]
                        const serverItem = sideEffects!.createdResults![addCursor++] ?? temp
                        const tempId = (temp as any)?.id
                        if (tempId !== undefined) map.delete(tempId)
                        const serverId = (serverItem as any)?.id
                        if (serverId !== undefined) map.set(serverId, serverItem as any)
                        applyResult.appliedData[idx] = serverItem
                    })
                    latest = map as any
                }
                store.set(atom, latest)
                versionTracker.bump(atom, changedFields)
            } else {
                // 乐观模式已写入 temp，若有 server 返回则替换为最终 ID
                rewriteCreated(sideEffects?.createdResults)
            }

            // 成功确认后统一触发 onSuccess（无论乐观或严格），优先携带服务端实体
            callbacks.forEach(({ onSuccess }, idx) => setTimeout(() => onSuccess?.(applyResult.appliedData[idx]), 0))

            // Record history only on success
            historyRecorder.record({ patches, inversePatches, atom, adapter })
        } catch (error) {
            adapter.onError?.(error as Error, 'applyPatches')

            if (mode === 'optimistic') {
                // rollback 乐观写入
                store.set(atom, originalValue)
            }
            const err = error instanceof Error ? error : new Error(String(error))
            callbacks.forEach(({ onFail }) => setTimeout(() => onFail?.(err), 0))
        }
    }
}
