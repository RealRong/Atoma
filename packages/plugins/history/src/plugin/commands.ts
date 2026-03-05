import type { Command, CommandResult, CommandSpec } from '@atoma-js/types/devtools'
import type { HistoryApply } from '@atoma-js/types/history'
import type { HistoryManager } from '../manager'

type HistoryOperation = (args: {
    scope: string
    apply: HistoryApply
}) => Promise<boolean>

const toScope = (scope?: string) => String(scope ?? 'default')
const toCommandScope = (command: Command): string | undefined => (
    typeof command.args?.scope === 'string' ? command.args.scope : undefined
)

const toErrorMessage = (error: unknown): string => {
    return error instanceof Error
        ? (error.message || 'Unknown error')
        : String(error ?? 'Unknown error')
}

export const historyCommandSpecs: CommandSpec[] = [
    { name: 'history.undo', title: 'Undo', argsJson: '{"scope":"default"}' },
    { name: 'history.redo', title: 'Redo', argsJson: '{"scope":"default"}' },
    { name: 'history.clear', title: 'Clear', argsJson: '{"scope":"default"}' }
]

export type HistoryCommands = Readonly<{
    canUndo: (scope?: string) => boolean
    canRedo: (scope?: string) => boolean
    clear: (scope?: string) => void
    undo: (scope?: string) => Promise<boolean>
    redo: (scope?: string) => Promise<boolean>
    invoke: (command: Command) => Promise<CommandResult>
}>

export function createCommands({
    manager,
    apply,
    emitChanged
}: {
    manager: HistoryManager
    apply: HistoryApply
    emitChanged: () => void
}): HistoryCommands {
    const runOperation = async (operation: HistoryOperation, scope?: string): Promise<boolean> => {
        const ok = await operation({
            scope: toScope(scope),
            apply
        })
        if (ok) emitChanged()
        return ok
    }

    const undo = (scope?: string) => runOperation(
        (replayArgs) => manager.undo(replayArgs),
        scope
    )
    const redo = (scope?: string) => runOperation(
        (replayArgs) => manager.redo(replayArgs),
        scope
    )

    const clear = (scope?: string): void => {
        manager.clear(toScope(scope))
        emitChanged()
    }

    return {
        canUndo: (scope) => manager.canUndo(toScope(scope)),
        canRedo: (scope) => manager.canRedo(toScope(scope)),
        clear,
        undo,
        redo,
        invoke: async (command): Promise<CommandResult> => {
            try {
                const scope = toCommandScope(command)
                switch (command.name) {
                    case 'history.undo':
                        return { ok: await undo(scope) }
                    case 'history.redo':
                        return { ok: await redo(scope) }
                    case 'history.clear':
                        clear(scope)
                        return { ok: true }
                    default:
                        return { ok: false, message: `unknown command: ${command.name}` }
                }
            } catch (error) {
                return { ok: false, message: toErrorMessage(error) }
            }
        }
    }
}
