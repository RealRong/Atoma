import type { AtomaHistory } from 'atoma-types/client'
import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import { DEBUG_HUB_TOKEN } from 'atoma-types/devtools'
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
    const manager = new HistoryManager()

    return {
        id: 'atoma-history',
        setup: (ctx: PluginContext) => {
            const stopEvents = ctx.events.register({
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

            const debugHub = ctx.services.resolve(DEBUG_HUB_TOKEN)
            const historyProviderId = `history.${ctx.clientId}`
            const unregisterDebugProvider = debugHub?.register({
                id: historyProviderId,
                kind: 'history',
                clientId: ctx.clientId,
                priority: 50,
                snapshot: () => {
                    return {
                        version: 1,
                        providerId: historyProviderId,
                        kind: 'history',
                        clientId: ctx.clientId,
                        timestamp: ctx.runtime.now(),
                        scope: { tab: 'history' },
                        data: buildSnapshot(manager)
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
                            await ctx.runtime.stores.applyPatches({
                                storeName: applyArgs.storeName,
                                patches: applyArgs.patches,
                                inversePatches: applyArgs.inversePatches,
                                opContext: applyArgs.opContext
                            })
                        }
                    })
                },
                redo: async (args) => {
                    const scope = toScope(args?.scope)
                    return await manager.redo({
                        scope,
                        apply: async (applyArgs) => {
                            await ctx.runtime.stores.applyPatches({
                                storeName: applyArgs.storeName,
                                patches: applyArgs.patches,
                                inversePatches: applyArgs.inversePatches,
                                opContext: applyArgs.opContext
                            })
                        }
                    })
                }
            }

            return {
                extension: { history },
                dispose: () => {
                    try {
                        stopEvents?.()
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
