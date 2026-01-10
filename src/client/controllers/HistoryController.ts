import type { OperationContext, StoreKey } from '#core'
import { Core } from '#core'
import type { Patch } from 'immer'
import type { AtomaHistory, ClientRuntime } from '../types'

export function createHistoryController(args: {
    runtime: ClientRuntime
}): Readonly<{
    history: AtomaHistory
    dispose: () => void
    devtools: Readonly<{
        snapshot: () => { scopes: Array<{ scope: string; canUndo: boolean; canRedo: boolean }> }
    }>
}> {
    const historyManager = new Core.history.HistoryManager()

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

        await new Promise<void>((resolve, reject) => {
            handle.services.mutation.runtime.dispatch({
                type: 'patches',
                patches,
                inversePatches,
                handle: handle as any,
                opContext,
                onSuccess: () => resolve(),
                onFail: (error?: Error) => reject(error ?? new Error('[Atoma] history: patches 写入失败'))
            } as any)
        })
    }

    const history: AtomaHistory = {
        canUndo: (scope?: string) => historyManager.canUndo(String(scope || 'default')),
        canRedo: (scope?: string) => historyManager.canRedo(String(scope || 'default')),
        clear: (scope?: string) => {
            historyManager.clear(String(scope || 'default'))
        },
        undo: async (undoArgs?: { scope?: string }) => {
            return historyManager.undo({
                scope: String(undoArgs?.scope || 'default'),
                apply: async (applyArgs) => {
                    await dispatchPatches(applyArgs.storeName, applyArgs.patches, applyArgs.inversePatches, applyArgs.opContext)
                }
            })
        },
        redo: async (redoArgs?: { scope?: string }) => {
            return historyManager.redo({
                scope: String(redoArgs?.scope || 'default'),
                apply: async (applyArgs) => {
                    await dispatchPatches(applyArgs.storeName, applyArgs.patches, applyArgs.inversePatches, applyArgs.opContext)
                }
            })
        }
    }

    const devtools = {
        snapshot: () => {
            const scopes = historyManager.listScopes()
                .map(scope => ({
                    scope,
                    canUndo: historyManager.canUndo(scope),
                    canRedo: historyManager.canRedo(scope)
                }))
                .sort((a, b) => a.scope.localeCompare(b.scope))
            return { scopes }
        }
    } as const

    const unsubscribers: Array<() => void> = []
    const unregister = args.runtime.onHandleCreated((handle) => {
        const unsub = handle.services.mutation.hooks.events.committed.on((e) => {
            const opContext = e?.opContext
            if (!opContext) return

            const storeName = String(e.storeName || handle.storeName)

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
        devtools,
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
