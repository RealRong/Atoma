import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import type { Source } from 'atoma-types/devtools'
import type { AtomaHistory, HistoryApplyArgs } from 'atoma-types/history'
import { HUB_TOKEN } from 'atoma-types/devtools'
import { HistoryManager } from './manager'
import { createCommands, historyCommandSpecs } from './plugin/commands'
import { bindEvents } from './plugin/events'
import { createSource } from './plugin/source'

export function historyPlugin(): ClientPlugin<{ history: AtomaHistory }> {
    return {
        id: 'atoma-history',
        setup: (ctx: PluginContext) => {
            const manager = new HistoryManager(ctx.runtime.action.createContext)
            const apply = async ({ storeName, changes, mode, context }: HistoryApplyArgs) => {
                const store = ctx.runtime.stores.use(storeName)
                if (mode === 'revert') {
                    await store.revert(
                        changes,
                        { context }
                    )
                    return
                }
                await store.apply(
                    changes,
                    { context }
                )
            }

            const sourceRuntime = createSource({
                clientId: ctx.clientId,
                now: ctx.runtime.now,
                manager,
                commands: historyCommandSpecs
            })
            const commands = createCommands({
                manager,
                apply,
                emitChanged: sourceRuntime.emitChanged
            })
            const stopEvents = bindEvents({
                events: ctx.events,
                manager,
                emitChanged: sourceRuntime.emitChanged
            })

            const source: Source = {
                spec: sourceRuntime.spec,
                snapshot: sourceRuntime.snapshot,
                subscribe: sourceRuntime.subscribe,
                invoke: commands.invoke
            }
            const hub = ctx.services.resolve(HUB_TOKEN)
            const unregisterSource = hub?.register(source)

            const history: AtomaHistory = {
                canUndo: commands.canUndo,
                canRedo: commands.canRedo,
                clear: commands.clear,
                undo: commands.undo,
                redo: commands.redo
            }

            return {
                extension: { history },
                dispose: () => {
                    while (stopEvents.length) {
                        try {
                            stopEvents.pop()?.()
                        } catch {
                            // ignore
                        }
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
