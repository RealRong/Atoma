import { PrimitiveAtom } from 'jotai/vanilla'
import { applyPatches, Patch } from 'immer'
import isEqual from 'lodash/isEqual'
import { ApplyResult } from './OperationApplier'
import { IAdapter, PatchMetadata, Entity, StoreDispatchEvent } from '../types'
import { AtomVersionTracker } from '../state/AtomVersionTracker'
import { HistoryRecorder } from '../history/HistoryRecorder'
import type { IndexRegistry } from '../indexes/IndexRegistry'
import { IndexSynchronizer } from '../indexes/IndexSynchronizer'
import type { DebugOptions } from '../../observability/types'
import { createDebugEmitter } from '../../observability/debug'
import type { InternalOperationContext } from '../../observability/types'

type CallbackEntry = { onSuccess?: (...args: any[]) => void, onFail?: (error?: Error) => void }

interface SyncParams<T extends Entity> {
    adapter: IAdapter<T>
    applyResult: ApplyResult<T>
    atom: PrimitiveAtom<Map<any, any>>
    callbacks: CallbackEntry[]
    store: any
    versionTracker: AtomVersionTracker
    historyRecorder: HistoryRecorder
    indexRegistry?: IndexRegistry
    mode: 'optimistic' | 'strict'
    traceId?: string
    debug?: DebugOptions
    debugSink?: (e: import('../../observability/types').DebugEvent) => void
    storeName?: string
}

type ApplySideEffects<T> = {
    createdResults?: T[]
}

const applyPatchesViaOperations = async <T extends Entity>(
    adapter: IAdapter<T>,
    patches: Patch[],
    _appliedData: T[],
    _operationTypes: StoreDispatchEvent<T>['type'][],
    internalContext?: InternalOperationContext
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

function mapsEqual(a: Map<any, any>, b: Map<any, any>) {
    if (a === b) return true
    if (a.size !== b.size) return false
    for (const [key, valA] of a.entries()) {
        if (!b.has(key)) return false
        const valB = b.get(key)
        if (!isEqual(valA, valB)) return false
    }
    return true
}

export class AdapterSync {
    async syncAtom<T extends Entity>(params: SyncParams<T>): Promise<void> {
        const { adapter, applyResult, atom, callbacks, store, versionTracker, historyRecorder, indexRegistry, mode } = params
        const { newValue, patches, inversePatches, changedFields } = applyResult
        const originalValue = store.get(atom)
        const indexManager = indexRegistry?.get(atom as any)

        const traceId = params.traceId
        const emitter = createDebugEmitter({
            debug: params.debug,
            traceId,
            store: params.storeName ?? adapter.name,
            sink: params.debugSink
        })
        const emit = (type: string, payload: any) => emitter?.emit(type, payload)

        const metadata: PatchMetadata = {
            atom,
            databaseName: adapter.name,
            timestamp: Date.now(),
            baseVersion: Date.now(),
            traceId
        }

        emit('mutation:patches', {
            patchCount: patches.length,
            inversePatchCount: inversePatches.length,
            changedFields: changedFields instanceof Set ? Array.from(changedFields) : undefined
        })

        // Optimistic: apply到本地，但不立即触发 onSuccess，待适配器确认后再回调
        if (mode === 'optimistic') {
            store.set(atom, newValue)
            versionTracker.bump(atom, changedFields)
            if (indexManager) {
                IndexSynchronizer.applyPatches(indexManager, originalValue, newValue, patches)
            }
        }

        let sideEffects: ApplySideEffects<T> | undefined

        try {
            if (adapter.applyPatches) {
                const internalContext = (typeof traceId === 'string' && traceId)
                    ? { traceId, store: params.storeName ?? adapter.name, emitter }
                    : undefined
                const res = await adapter.applyPatches(patches, metadata, internalContext)
                if (res && typeof res === 'object' && Array.isArray((res as any).created)) {
                    sideEffects = { createdResults: (res as any).created as T[] }
                }
            } else {
                const internalContext = (typeof traceId === 'string' && traceId)
                    ? { traceId, store: params.storeName ?? adapter.name, emitter }
                    : undefined
                sideEffects = await applyPatchesViaOperations(
                    adapter,
                    patches,
                    applyResult.appliedData,
                    applyResult.operationTypes,
                    internalContext
                )
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

                if (!mapsEqual(current, next)) {
                    store.set(atom, next)
                    versionTracker.bump(atom, new Set(['id']))
                    if (indexManager) {
                        IndexSynchronizer.applyMapDiff(indexManager, current as any, next as any)
                    }
                }
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
                if (!mapsEqual(currentValue, latest)) {
                    store.set(atom, latest)
                    versionTracker.bump(atom, changedFields)
                    if (indexManager) {
                        IndexSynchronizer.applyMapDiff(indexManager, currentValue as any, latest as any)
                    }
                }
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
                if (indexManager) {
                    // 对称回滚：以 inversePatches 驱动索引恢复
                    IndexSynchronizer.applyPatches(indexManager, newValue, originalValue, inversePatches)
                }
            }
            emit('mutation:rollback', { reason: 'adapter_error' })
            const err = error instanceof Error ? error : new Error(String(error))
            callbacks.forEach(({ onFail }) => setTimeout(() => onFail?.(err), 0))
        }
    }
}
