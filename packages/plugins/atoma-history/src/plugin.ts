import type { AtomaHistory, ClientPlugin, ClientPluginContext } from 'atoma-types/client'
import { DEVTOOLS_REGISTRY_KEY, type DevtoolsRegistry } from 'atoma-types/devtools'
import { HistoryManager } from './history-manager'

const toScope = (scope?: string) => String(scope ?? 'default')

const buildSnapshot = (manager: HistoryManager) => {
    return {
        scopes: manager.listScopes().map(scope => ({
            scope,
            canUndo: manager.canUndo(scope),
            canRedo: manager.canRedo(scope)
        }))
    }
}

export function historyPlugin(): ClientPlugin<{ history: AtomaHistory }> {
    return {
        id: 'atoma-history',
        init: (ctx: ClientPluginContext) => {
            const manager = new HistoryManager()

            const registry = ctx.capabilities.get<DevtoolsRegistry>(DEVTOOLS_REGISTRY_KEY)
            const unregisterDevtools = registry?.register?.('history', {
                snapshot: () => buildSnapshot(manager)
            })

            const stopHooks = ctx.hooks.register({
                write: {
                    onPatches: (args) => {
                        manager.record({
                            storeName: String(args.handle.storeName),
                            patches: args.patches,
                            inversePatches: args.inversePatches,
                            opContext: args.opContext
                        })
                    }
                }
            })

            const history: AtomaHistory = {
                canUndo: (scope) => manager.canUndo(toScope(scope)),
                canRedo: (scope) => manager.canRedo(toScope(scope)),
                clear: (scope) => manager.clear(toScope(scope)),
                undo: async (args) => {
                    const scope = toScope(args?.scope)
                    return await manager.undo({
                        scope,
                        apply: async (applyArgs) => {
                            const handle = ctx.runtime.stores.resolveHandle(applyArgs.storeName, 'history.undo')
                            await ctx.runtime.write.patches(
                                handle,
                                applyArgs.patches,
                                applyArgs.inversePatches,
                                { opContext: applyArgs.opContext }
                            )
                        }
                    })
                },
                redo: async (args) => {
                    const scope = toScope(args?.scope)
                    return await manager.redo({
                        scope,
                        apply: async (applyArgs) => {
                            const handle = ctx.runtime.stores.resolveHandle(applyArgs.storeName, 'history.redo')
                            await ctx.runtime.write.patches(
                                handle,
                                applyArgs.patches,
                                applyArgs.inversePatches,
                                { opContext: applyArgs.opContext }
                            )
                        }
                    })
                }
            }

            return {
                extension: { history },
                dispose: () => {
                    try {
                        stopHooks()
                    } catch {
                        // ignore
                    }
                    try {
                        unregisterDevtools?.()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
