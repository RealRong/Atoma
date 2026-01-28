import type { ClientPlugin } from 'atoma/client'
import type { AtomaHistory } from 'atoma/client'
import type { HistoryApplyArgs } from './HistoryManager'
import { HistoryManager } from './HistoryManager'

const scopeKey = (scope?: string) => String(scope || 'default')

function snapshot(history: HistoryManager) {
    const scopes = history.listScopes()
        .map(scope => ({
            scope,
            canUndo: history.canUndo(scope),
            canRedo: history.canRedo(scope)
        }))
        .sort((a, b) => a.scope.localeCompare(b.scope))
    return { scopes }
}

export function historyPlugin(): ClientPlugin<{ History: AtomaHistory }> {
    return {
        name: 'history',
        setup: (ctx) => {
            const history = new HistoryManager()

            const unsubscribe = ctx.commit.subscribe((commit) => {
                history.record(commit)
            })

            const apply = (args: HistoryApplyArgs) => {
                return ctx.commit.applyPatches({
                    storeName: args.storeName,
                    patches: args.patches,
                    inversePatches: args.inversePatches,
                    opContext: args.opContext
                })
            }

            const History: AtomaHistory = {
                canUndo: (scope) => history.canUndo(scopeKey(scope)),
                canRedo: (scope) => history.canRedo(scopeKey(scope)),
                clear: (scope) => history.clear(scopeKey(scope)),
                undo: (args) => history.undo({ scope: scopeKey(args?.scope), apply }),
                redo: (args) => history.redo({ scope: scopeKey(args?.scope), apply })
            }

            const unregisterDevtools = ctx.devtools.register('history', () => snapshot(history))

            const dispose = () => {
                try {
                    unsubscribe()
                } catch {
                    // ignore
                }
                try {
                    unregisterDevtools()
                } catch {
                    // ignore
                }
            }

            ctx.onDispose(dispose)

            return {
                extension: { History },
                dispose
            }
        }
    }
}
