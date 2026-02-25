import type { Command, CommandResult, CommandSpec } from 'atoma-types/devtools'
import type { HistoryApply } from 'atoma-types/history'
import type { HistoryManager } from '../history-manager'

type HistoryOperation = 'undo' | 'redo'
type HistoryCommandName = 'history.undo' | 'history.redo' | 'history.clear'

const toScope = (scope?: string) => String(scope ?? 'default')
const toCommandScope = (scope: unknown): string | undefined => {
    return typeof scope === 'string' ? scope : undefined
}

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

export function createCommands(args: {
    manager: HistoryManager
    apply: HistoryApply
    emitChanged: () => void
}): HistoryCommands {
    const runOperation = async (operation: HistoryOperation, scope?: string): Promise<boolean> => {
        const targetScope = toScope(scope)
        const ok = operation === 'undo'
            ? await args.manager.undo({ scope: targetScope, apply: args.apply })
            : await args.manager.redo({ scope: targetScope, apply: args.apply })
        if (ok) args.emitChanged()
        return ok
    }

    const clear = (scope?: string) => {
        args.manager.clear(toScope(scope))
        args.emitChanged()
    }

    const commandHandlers: Record<HistoryCommandName, (scope?: string) => Promise<CommandResult>> = {
        'history.undo': async (scope) => ({ ok: await runOperation('undo', scope) }),
        'history.redo': async (scope) => ({ ok: await runOperation('redo', scope) }),
        'history.clear': async (scope) => {
            clear(scope)
            return { ok: true }
        }
    }

    return {
        canUndo: (scope) => args.manager.canUndo(toScope(scope)),
        canRedo: (scope) => args.manager.canRedo(toScope(scope)),
        clear,
        undo: (scope) => runOperation('undo', scope),
        redo: (scope) => runOperation('redo', scope),
        invoke: async (command): Promise<CommandResult> => {
            try {
                const handler = commandHandlers[command.name as HistoryCommandName]
                if (handler) {
                    return await handler(toCommandScope(command.args?.scope))
                }
                return { ok: false, message: `unknown command: ${command.name}` }
            } catch (error) {
                return { ok: false, message: toErrorMessage(error) }
            }
        }
    }
}
