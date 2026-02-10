import type { AtomaHistory } from 'atoma-types/client'
import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import { DEBUG_HUB_CAPABILITY } from 'atoma-types/devtools'
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
        init: (ctx: PluginContext) => {
            const manager = new HistoryManager()

            const debugHub = ctx.capabilities.get(DEBUG_HUB_CAPABILITY)
            const historyProviderId = `history.${ctx.runtime.id}`
            const unregisterDebugProvider = debugHub?.register({
                id: historyProviderId,
                kind: 'history',
                clientId: ctx.runtime.id,
                priority: 50,
                snapshot: () => {
                    return {
                        version: 1,
                        providerId: historyProviderId,
                        kind: 'history',
                        clientId: ctx.runtime.id,
                        timestamp: ctx.runtime.now(),
                        scope: { tab: 'history' },
                        data: buildSnapshot(manager)
                    }
                }
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
                        unregisterDebugProvider?.()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
