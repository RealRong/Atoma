import type { OperationContext, StoreKey } from '#core'
import { Core } from '#core'
import type { Patch } from 'immer'
import type { AtomaHistory } from '../types'
import type { ClientRuntime } from '../runtime'

type IdRemapSink = (storeName: string, from: StoreKey, to: StoreKey) => void

export function createHistoryController(args: {
    runtime: ClientRuntime
}): Readonly<{
    history: AtomaHistory
    recordIdRemap: IdRemapSink
    dispose: () => void
}> {
    const historyManager = new Core.history.HistoryManager()

    const idRemapByStore = new Map<string, Map<StoreKey, StoreKey>>()

    const resolveId = (storeName: string, id: StoreKey): StoreKey => {
        const key = String(storeName || 'store')
        const map = idRemapByStore.get(key)
        if (!map) return id

        const visited: StoreKey[] = []
        let cur: StoreKey = id

        while (true) {
            const next = map.get(cur)
            if (next === undefined) break
            if (next === cur) break
            visited.push(cur)
            cur = next

            if (visited.length > 50) break
        }

        if (!visited.length) return cur
        for (const v of visited) {
            map.set(v, cur)
        }
        return cur
    }

    const recordIdRemap: IdRemapSink = (storeName, from, to) => {
        const key = String(storeName || 'store')

        const resolvedFrom = resolveId(key, from)
        const resolvedTo = resolveId(key, to)
        if (resolvedFrom === resolvedTo) return

        let map = idRemapByStore.get(key)
        if (!map) {
            map = new Map()
            idRemapByStore.set(key, map)
        }

        map.set(resolvedFrom, resolvedTo)
        if (from !== resolvedFrom) {
            map.set(from, resolvedTo)
        }
    }

    const rewritePatchesForState = (storeName: string, handle: any, patches: Patch[]) => {
        const current = handle.jotaiStore.get(handle.atom) as Map<StoreKey, any>

        let changed = false
        const out = patches.map((p) => {
            const path = (p as any)?.path
            const root = Array.isArray(path) ? path[0] : undefined
            const isStoreKey = (typeof root === 'string') || (typeof root === 'number' && Number.isFinite(root))
            if (!isStoreKey) return p
            if (current.has(root)) return p

            const resolved = resolveId(storeName, root)
            if (resolved === root) return p
            if (!current.has(resolved)) return p

            changed = true
            const nextPath = Array.isArray(path) ? path.slice() : []
            nextPath[0] = resolved as any

            const next: any = { ...(p as any), path: nextPath }

            if ((p.op === 'add' || p.op === 'replace') && nextPath.length === 1) {
                const value = (p as any).value
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const nextId = resolved
                    if ((value as any).id !== nextId) {
                        next.value = { ...(value as any), id: nextId as any }
                    }
                }
            }

            return next as Patch
        })

        return changed ? out : patches
    }

    const dispatchPatches = async (
        storeName: string,
        patches: Patch[],
        inversePatches: Patch[],
        opContext: OperationContext
    ) => {
        const store = args.runtime.resolveStore(storeName)
        const handle = Core.store.getHandle(store)
        if (!handle) {
            throw new Error(`[Atoma] history: 未找到 storeHandle（store="${storeName}"）`)
        }

        const rewrittenPatches = rewritePatchesForState(storeName, handle, patches)
        const rewrittenInversePatches = rewritePatchesForState(storeName, handle, inversePatches)

        await new Promise<void>((resolve, reject) => {
            Core.store.BaseStore.dispatch({
                type: 'patches',
                patches: rewrittenPatches,
                inversePatches: rewrittenInversePatches,
                handle: handle as any,
                opContext,
                onSuccess: () => resolve(),
                onFail: (error?: Error) => reject(error ?? new Error('[Atoma] history: patches 写入失败'))
            } as any)
        })
    }

    const history: AtomaHistory = {
        canUndo: (scope: string) => historyManager.canUndo(String(scope || 'default')),
        canRedo: (scope: string) => historyManager.canRedo(String(scope || 'default')),
        undo: async (undoArgs: { scope: string }) => {
            return historyManager.undo({
                scope: String(undoArgs.scope || 'default'),
                apply: async (applyArgs) => {
                    await dispatchPatches(applyArgs.storeName, applyArgs.patches, applyArgs.inversePatches, applyArgs.opContext)
                }
            })
        },
        redo: async (redoArgs: { scope: string }) => {
            return historyManager.redo({
                scope: String(redoArgs.scope || 'default'),
                apply: async (applyArgs) => {
                    await dispatchPatches(applyArgs.storeName, applyArgs.patches, applyArgs.inversePatches, applyArgs.opContext)
                }
            })
        }
    }

    const unsubscribers: Array<() => void> = []
    const unregister = args.runtime.onHandleCreated((handle) => {
        const unsub = handle.services.mutation.hooks.events.committed.on((e) => {
            const opContext = e?.opContext
            if (!opContext) return

            const storeName = String(e.storeName || handle.storeName)

            const created = e?.persistResult?.created
            if (Array.isArray(created) && created.length) {
                let addCursor = 0
                const operationTypes = e?.plan?.operationTypes
                const operations = e?.operations
                if (Array.isArray(operationTypes) && Array.isArray(operations)) {
                    operationTypes.forEach((type: unknown, idx: number) => {
                        if (type !== 'add') return
                        const tempId = (operations[idx] as any)?.data?.id
                        const serverItem = created[addCursor++]
                        const serverId = (serverItem as any)?.id
                        if (tempId !== undefined && serverId !== undefined) {
                            recordIdRemap(storeName, tempId, serverId)
                        }
                    })
                }
            }

            historyManager.record({
                storeName,
                patches: e.plan?.patches ?? [],
                inversePatches: e.plan?.inversePatches ?? [],
                opContext
            })
        })
        unsubscribers.push(unsub)
    }, { replay: true })
    unsubscribers.push(unregister)

    return {
        history,
        recordIdRemap,
        dispose: () => {
            for (const unsub of unsubscribers) {
                try {
                    unsub()
                } catch {
                    // ignore
                }
            }
        }
    }
}
