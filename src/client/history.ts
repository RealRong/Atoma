import type { OperationContext } from '#core'
import { Core } from '#core'
import type { Patch } from 'immer'
import type { AtomaHistory } from './types'
import type { ClientPlugin } from './plugins'
import type { ClientRuntime } from './runtime'

export function createHistoryPlugin(): ClientPlugin {
    return {
        name: 'history',
        setup: (runtime: ClientRuntime) => {
            const historyManager = new Core.history.HistoryManager()

            const dispatchPatches = async (
                storeName: string,
                patches: Patch[],
                inversePatches: Patch[],
                opContext: OperationContext
            ) => {
                const store = runtime.resolveStore(storeName)
                const handle = Core.store.getHandle(store)
                if (!handle) {
                    throw new Error(`[Atoma] history: 未找到 storeHandle（store="${storeName}"）`)
                }

                await new Promise<void>((resolve, reject) => {
                    Core.store.BaseStore.dispatch({
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
            const unregister = runtime.onHandleCreated((handle) => {
                const unsub = handle.services.mutation.hooks.events.committed.on((e: any) => {
                    const opContext = e?.opContext
                    if (!opContext) return
                    historyManager.record({
                        storeName: String(e.storeName || handle.storeName),
                        patches: e.plan?.patches ?? [],
                        inversePatches: e.plan?.inversePatches ?? [],
                        opContext
                    })
                })
                unsubscribers.push(unsub)
            }, { replay: true })
            unsubscribers.push(unregister)

            return {
                client: { history },
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
    }
}
