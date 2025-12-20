import { PrimitiveAtom } from 'jotai/vanilla'
import { applyPatches, Patch } from 'immer'
import isEqual from 'lodash/isEqual'
import { ApplyResult } from './OperationApplier'
import { IAdapter, PatchMetadata, Entity, StoreDispatchEvent, type OperationContext } from '../types'
import { AtomVersionTracker } from '../state/AtomVersionTracker'
import type { OperationRecorder } from './OperationRecorder'
import type { StoreIndexes } from '../indexes/StoreIndexes'
import type { ObservabilityContext } from '../../observability/types'

type CallbackEntry = { onSuccess?: (...args: any[]) => void, onFail?: (error?: Error) => void }

interface SyncParams<T extends Entity> {
    adapter: IAdapter<T>
    applyResult: ApplyResult<T>
    atom: PrimitiveAtom<Map<any, any>>
    callbacks: CallbackEntry[]
    store: any
    versionTracker: AtomVersionTracker
    operationRecorder: OperationRecorder
    indexes?: StoreIndexes<T> | null
    mode: 'optimistic' | 'strict'
    observabilityContext: ObservabilityContext
    storeName?: string
    opContext?: OperationContext
}

type ApplySideEffects<T> = {
    createdResults?: T[]
}

const applyPatchesViaOperations = async <T extends Entity>(
    adapter: IAdapter<T>,
    _patches: Patch[],
    appliedData: T[],
    operationTypes: StoreDispatchEvent<T>['type'][],
    internalContext?: ObservabilityContext
): Promise<ApplySideEffects<T>> => {
    if (operationTypes.length === 1 && operationTypes[0] === 'patches') {
        const putActions: T[] = []
        const deleteKeys: Array<string | number> = []

        _patches.forEach(p => {
            if (p.path.length !== 1) return
            const id = p.path[0] as any
            if (p.op === 'remove') {
                deleteKeys.push(id)
                return
            }
            if (p.op === 'add' || p.op === 'replace') {
                const val = p.value as any
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
        const { adapter, applyResult, atom, callbacks, store, versionTracker, operationRecorder, indexes, mode } = params
        const { newValue, patches, inversePatches, changedFields } = applyResult
        const originalValue = store.get(atom)
        const activeIndexes = indexes ?? null

        const ctx = params.observabilityContext
        const traceId = ctx.traceId
        const emit = (type: string, payload: any) => ctx.emit(type as any, payload)

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
            activeIndexes?.applyPatches(originalValue, newValue, patches)
        }

        let sideEffects: ApplySideEffects<T> | undefined

        try {
            if (adapter.applyPatches) {
                const res = await adapter.applyPatches(patches, metadata, ctx)
                if (res && typeof res === 'object' && Array.isArray((res as any).created)) {
                    sideEffects = { createdResults: (res as any).created as T[] }
                }
            } else {
                sideEffects = await applyPatchesViaOperations(
                    adapter,
                    patches,
                    applyResult.appliedData,
                    applyResult.operationTypes,
                    ctx
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
                    activeIndexes?.applyMapDiff(current as any, next as any)
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
                    activeIndexes?.applyMapDiff(currentValue as any, latest as any)
                }
            } else {
                // 乐观模式已写入 temp，若有 server 返回则替换为最终 ID
                rewriteCreated(sideEffects?.createdResults)
            }

            // 成功确认后统一触发 onSuccess（无论乐观或严格），优先携带服务端实体
            callbacks.forEach(({ onSuccess }, idx) => setTimeout(() => onSuccess?.(applyResult.appliedData[idx]), 0))

            // 记录成功写入（由上层 recorder 决定是否入 history）
            if (params.storeName && params.opContext) {
                operationRecorder.record({
                    storeName: params.storeName,
                    opContext: params.opContext,
                    patches,
                    inversePatches
                })
            }
        } catch (error) {
            adapter.onError?.(error as Error, 'applyPatches')

            if (mode === 'optimistic') {
                // rollback 乐观写入
                store.set(atom, originalValue)
                // 对称回滚：以 inversePatches 驱动索引恢复
                activeIndexes?.applyPatches(newValue, originalValue, inversePatches)
            }
            emit('mutation:rollback', { reason: 'adapter_error' })
            const err = error instanceof Error ? error : new Error(String(error))
            callbacks.forEach(({ onFail }) => setTimeout(() => onFail?.(err), 0))
        }
    }
}
