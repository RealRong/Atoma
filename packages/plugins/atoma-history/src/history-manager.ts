import type { ChangeDirection, Entity, ActionContext, StoreChange } from 'atoma-types/core'
import type { ActionRecord, ChangeRecord, UndoStack } from './types'

export type HistoryRecordArgs = Readonly<{
    storeName: string
    changes: ReadonlyArray<StoreChange<Entity>>
    context: ActionContext
}>

export type HistoryApplyArgs = Readonly<{
    storeName: string
    changes: ReadonlyArray<StoreChange<Entity>>
    direction: ChangeDirection
    context: ActionContext
}>

export type HistoryApply = (args: HistoryApplyArgs) => Promise<void>

type ContextBuilder = (context?: Partial<ActionContext>) => ActionContext

export class HistoryManager {
    private readonly history: InMemoryHistory
    private readonly createContext: ContextBuilder

    constructor(createContext: ContextBuilder) {
        this.history = new InMemoryHistory()
        this.createContext = createContext
    }

    listScopes(): string[] {
        return this.history.listScopes()
    }

    record(args: HistoryRecordArgs) {
        this.history.recordChange({
            storeName: args.storeName,
            changes: args.changes,
            context: args.context
        })
    }

    canUndo(scope: string): boolean {
        return this.history.canUndo(scope)
    }

    canRedo(scope: string): boolean {
        return this.history.canRedo(scope)
    }

    beginAction(args: { scope: string; label?: string; origin?: ActionContext['origin'] }): ActionContext {
        return this.createContext({
            scope: String(args.scope || 'default'),
            origin: args.origin ?? 'user',
            label: args.label
        })
    }

    async undo(args: { scope: string; apply: HistoryApply }): Promise<boolean> {
        const action = this.history.popUndo(args.scope)
        if (!action) return false

        const context = this.createContext({
            scope: String(args.scope || 'default'),
            origin: 'history',
            label: action.label
        })

        try {
            for (let i = action.changes.length - 1; i >= 0; i--) {
                const change = action.changes[i]
                await args.apply({
                    storeName: change.storeName,
                    changes: change.changes,
                    direction: 'backward',
                    context
                })
            }
            this.history.pushRedo(args.scope, action)
            return true
        } catch (e) {
            this.history.pushUndo(args.scope, action)
            throw e
        }
    }

    async redo(args: { scope: string; apply: HistoryApply }): Promise<boolean> {
        const action = this.history.popRedo(args.scope)
        if (!action) return false

        const context = this.createContext({
            scope: String(args.scope || 'default'),
            origin: 'history',
            label: action.label
        })

        try {
            for (let i = 0; i < action.changes.length; i++) {
                const change = action.changes[i]
                await args.apply({
                    storeName: change.storeName,
                    changes: change.changes,
                    direction: 'forward',
                    context
                })
            }
            this.history.pushUndo(args.scope, action)
            return true
        } catch (e) {
            this.history.pushRedo(args.scope, action)
            throw e
        }
    }

    clear(scope: string) {
        this.history.clear(scope)
    }
}

class InMemoryHistory {
    private stacks = new Map<string, UndoStack>()

    listScopes(): string[] {
        return Array.from(this.stacks.keys())
    }

    private getStack(scope: string): UndoStack {
        const key = scope || 'default'
        const existing = this.stacks.get(key)
        if (existing) return existing
        const created: UndoStack = { undo: [], redo: [] }
        this.stacks.set(key, created)
        return created
    }

    recordChange(change: ChangeRecord) {
        if (change.context.origin !== 'user') return
        if (!change.storeName) return

        const scope = change.context.scope || 'default'
        const id = change.context.id

        const stack = this.getStack(scope)
        const last = stack.undo[stack.undo.length - 1]

        if (last && last.id === id) {
            last.changes.push(change)
            if (!last.label && change.context.label) {
                last.label = change.context.label
            }
            stack.redo = []
            return
        }

        const next: ActionRecord = {
            scope,
            id,
            origin: 'user',
            label: change.context.label,
            changes: [change]
        }

        stack.undo.push(next)
        stack.redo = []
    }

    canUndo(scope: string): boolean {
        return this.getStack(scope).undo.length > 0
    }

    canRedo(scope: string): boolean {
        return this.getStack(scope).redo.length > 0
    }

    popUndo(scope: string): ActionRecord | undefined {
        return this.getStack(scope).undo.pop()
    }

    pushUndo(scope: string, action: ActionRecord) {
        this.getStack(scope).undo.push(action)
    }

    popRedo(scope: string): ActionRecord | undefined {
        return this.getStack(scope).redo.pop()
    }

    pushRedo(scope: string, action: ActionRecord) {
        this.getStack(scope).redo.push(action)
    }

    clear(scope: string) {
        const key = scope || 'default'
        this.stacks.delete(key)
    }
}
