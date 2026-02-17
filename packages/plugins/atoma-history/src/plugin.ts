import type { AtomaHistory } from 'atoma-types/client'
import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import type { ChangeDirection, Entity, ActionContext, StoreChange } from 'atoma-types/core'
import type { CommandResult, Source, StreamEvent } from 'atoma-types/devtools'
import { HUB_TOKEN } from 'atoma-types/devtools'
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
        setup: (ctx: PluginContext) => {
            const manager = new HistoryManager(ctx.runtime.action.createContext)
            const clientId = ctx.clientId
            const sourceId = `history.${clientId}`
            let revision = 0
            const subscribers = new Set<(event: StreamEvent) => void>()

            const emitChanged = () => {
                revision += 1
                const event: StreamEvent = {
                    version: 1,
                    sourceId,
                    clientId,
                    panelId: 'history',
                    type: 'data:changed',
                    revision,
                    timestamp: ctx.runtime.now()
                }
                for (const subscriber of subscribers) {
                    try {
                        subscriber(event)
                    } catch {
                        // ignore
                    }
                }
            }

            const apply = async (args: {
                storeName: string
                changes: StoreChange<Entity>[]
                direction: ChangeDirection
                context: ActionContext
            }) => {
                await ctx.runtime.stores.applyChanges(
                    args.storeName,
                    args.changes,
                    args.direction,
                    { context: args.context }
                )
            }

            const runUndo = async (scope?: string): Promise<boolean> => {
                const ok = await manager.undo({
                    scope: toScope(scope),
                    apply
                })
                if (ok) emitChanged()
                return ok
            }

            const runRedo = async (scope?: string): Promise<boolean> => {
                const ok = await manager.redo({
                    scope: toScope(scope),
                    apply
                })
                if (ok) emitChanged()
                return ok
            }

            const runClear = (scope?: string): void => {
                manager.clear(toScope(scope))
                emitChanged()
            }

            const stopEvents = ctx.events.register({
                write: {
                    onCommitted: (args) => {
                        if (!args.changes?.length) return
                        manager.record({
                            storeName: String(args.handle.storeName),
                            changes: args.changes as StoreChange<Entity>[],
                            context: args.context
                        })
                        emitChanged()
                    }
                }
            })

            const hub = ctx.services.resolve(HUB_TOKEN)
            const source: Source = {
                spec: {
                    id: sourceId,
                    clientId,
                    namespace: 'history',
                    title: 'History',
                    priority: 50,
                    panels: [
                        { id: 'history', title: 'History', order: 50, renderer: 'stats' },
                        { id: 'raw', title: 'Raw', order: 999, renderer: 'raw' }
                    ],
                    capability: {
                        snapshot: true,
                        stream: true,
                        command: true
                    },
                    tags: ['plugin'],
                    commands: [
                        { name: 'history.undo', title: 'Undo', argsJson: '{"scope":"default"}' },
                        { name: 'history.redo', title: 'Redo', argsJson: '{"scope":"default"}' },
                        { name: 'history.clear', title: 'Clear', argsJson: '{"scope":"default"}' }
                    ]
                },
                snapshot: () => {
                    return {
                        version: 1,
                        sourceId,
                        clientId,
                        panelId: 'history',
                        revision,
                        timestamp: ctx.runtime.now(),
                        data: buildSnapshot(manager)
                    }
                },
                subscribe: (fn) => {
                    subscribers.add(fn)
                    return () => {
                        subscribers.delete(fn)
                    }
                },
                invoke: async (command): Promise<CommandResult> => {
                    try {
                        if (command.name === 'history.undo') {
                            const scope = typeof command.args?.scope === 'string'
                                ? command.args.scope
                                : undefined
                            const ok = await runUndo(scope)
                            return { ok }
                        }
                        if (command.name === 'history.redo') {
                            const scope = typeof command.args?.scope === 'string'
                                ? command.args.scope
                                : undefined
                            const ok = await runRedo(scope)
                            return { ok }
                        }
                        if (command.name === 'history.clear') {
                            const scope = typeof command.args?.scope === 'string'
                                ? command.args.scope
                                : undefined
                            runClear(scope)
                            return { ok: true }
                        }
                        return { ok: false, message: `unknown command: ${command.name}` }
                    } catch (error) {
                        const message = error instanceof Error
                            ? (error.message || 'Unknown error')
                            : String(error ?? 'Unknown error')
                        return { ok: false, message }
                    }
                }
            }
            const unregisterSource = hub?.register(source)

            const history: AtomaHistory = {
                canUndo: (scope) => manager.canUndo(toScope(scope)),
                canRedo: (scope) => manager.canRedo(toScope(scope)),
                clear: (scope) => runClear(scope),
                undo: async (args) => {
                    return await runUndo(args?.scope)
                },
                redo: async (args) => {
                    return await runRedo(args?.scope)
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
                        unregisterSource?.()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
