import type { OperationContext } from '#core'
import { Core } from '#core'
import type { Patch } from 'immer'
import type { AtomaHistory, ClientRuntime } from '../../types'

export function createHistoryController(args: {
    runtime: ClientRuntime
}): Readonly<{
    history: AtomaHistory
    dispose: () => void
    devtools: Readonly<{
        snapshot: () => { scopes: Array<{ scope: string; canUndo: boolean; canRedo: boolean }> }
    }>
}> {
    const historyManager = args.runtime.mutation.history

    const dispatchPatches = (
        storeName: string,
        patches: Patch[],
        inversePatches: Patch[],
        opContext: OperationContext
    ): Promise<void> => {
        const store = args.runtime.resolveStore(storeName)
        const handle = Core.store.getHandle(store)
        if (!handle) {
            throw new Error(`[Atoma] history: 未找到 storeHandle（store="${storeName}"）`)
        }

        return new Promise<void>((resolve, reject) => {
            args.runtime.mutation.runtime.dispatch({
                type: 'patches',
                patches,
                inversePatches,
                handle,
                opContext,
                onSuccess: resolve,
                onFail: (error?: Error) => reject(error ?? new Error('[Atoma] history: patches 写入失败'))
            } as any)
        })
    }

    const scopeKey = (scope?: string) => String(scope || 'default')

    const apply = (applyArgs: { storeName: string; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => {
        return dispatchPatches(applyArgs.storeName, applyArgs.patches, applyArgs.inversePatches, applyArgs.opContext)
    }

    const history: AtomaHistory = {
        canUndo: (scope?: string) => historyManager.canUndo(scopeKey(scope)),
        canRedo: (scope?: string) => historyManager.canRedo(scopeKey(scope)),
        clear: (scope?: string) => historyManager.clear(scopeKey(scope)),
        undo: (undoArgs?: { scope?: string }) => {
            return historyManager.undo({
                scope: scopeKey(undoArgs?.scope),
                apply
            })
        },
        redo: (redoArgs?: { scope?: string }) => {
            return historyManager.redo({
                scope: scopeKey(redoArgs?.scope),
                apply
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

    return {
        history,
        devtools,
        dispose: () => {
            // history 由 mutation pipeline 内置维护，无需 dispose
        }
    }
}
