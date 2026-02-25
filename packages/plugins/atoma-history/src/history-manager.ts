import type { Entity, ActionContext, StoreChange } from 'atoma-types/core'
import type { ActionRecord, ChangeRecord, UndoStack } from './types'

export type HistoryRecordArgs = Readonly<{
    storeName: string
    changes: ReadonlyArray<StoreChange<Entity>>
    context: ActionContext
}>

export type HistoryApplyArgs = Readonly<{
    storeName: string
    changes: ReadonlyArray<StoreChange<Entity>>
    mode: 'apply' | 'revert'
    context: ActionContext
}>

export type HistoryApply = (args: HistoryApplyArgs) => Promise<void>

type ContextBuilder = (context?: Partial<ActionContext>) => ActionContext
type HistoryStack = 'undo' | 'redo'
type ReplayPlan = Readonly<{
    from: HistoryStack
    onSuccess: HistoryStack
    onError: HistoryStack
    mode: HistoryApplyArgs['mode']
    reverse: boolean
}>

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
            scope: this.toScope(args.scope),
            origin: args.origin ?? 'user',
            label: args.label
        })
    }

    async undo(args: { scope: string; apply: HistoryApply }): Promise<boolean> {
        return this.replay({
            scope: args.scope,
            apply: args.apply,
            plan: {
                from: 'undo',
                onSuccess: 'redo',
                onError: 'undo',
                mode: 'revert',
                reverse: true
            }
        })
    }

    async redo(args: { scope: string; apply: HistoryApply }): Promise<boolean> {
        return this.replay({
            scope: args.scope,
            apply: args.apply,
            plan: {
                from: 'redo',
                onSuccess: 'undo',
                onError: 'redo',
                mode: 'apply',
                reverse: false
            }
        })
    }

    clear(scope: string) {
        this.history.clear(scope)
    }

    private toScope(scope: string): string {
        return String(scope || 'default')
    }

    private pop(scope: string, stack: HistoryStack): ActionRecord | undefined {
        return stack === 'undo'
            ? this.history.popUndo(scope)
            : this.history.popRedo(scope)
    }

    private push(scope: string, stack: HistoryStack, action: ActionRecord) {
        if (stack === 'undo') {
            this.history.pushUndo(scope, action)
            return
        }
        this.history.pushRedo(scope, action)
    }

    private async replay(args: {
        scope: string
        apply: HistoryApply
        plan: ReplayPlan
    }): Promise<boolean> {
        const action = this.pop(args.scope, args.plan.from)
        if (!action) return false

        const context = this.createContext({
            scope: this.toScope(args.scope),
            origin: 'history',
            label: action.label
        })

        try {
            if (args.plan.reverse) {
                for (let i = action.changes.length - 1; i >= 0; i--) {
                    const change = action.changes[i]
                    await args.apply({
                        storeName: change.storeName,
                        changes: change.changes,
                        mode: args.plan.mode,
                        context
                    })
                }
            } else {
                for (const change of action.changes) {
                    await args.apply({
                        storeName: change.storeName,
                        changes: change.changes,
                        mode: args.plan.mode,
                        context
                    })
                }
            }
            this.push(args.scope, args.plan.onSuccess, action)
            return true
        } catch (error) {
            this.push(args.scope, args.plan.onError, action)
            throw error
        }
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
