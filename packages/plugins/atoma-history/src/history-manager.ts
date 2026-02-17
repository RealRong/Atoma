import type { ChangeDirection, Entity, OperationContext, StoreChange } from 'atoma-types/core'
import { createOperationContext } from 'atoma-core/operation'
import type { ActionRecord, ChangeRecord, UndoStack } from './types'

export type HistoryRecordArgs = Readonly<{
    storeName: string
    changes: StoreChange<Entity>[]
    opContext: OperationContext
}>

export type HistoryApplyArgs = Readonly<{
    storeName: string
    changes: StoreChange<Entity>[]
    direction: ChangeDirection
    opContext: OperationContext
}>

export type HistoryApply = (args: HistoryApplyArgs) => Promise<void>


export class HistoryManager {
    private readonly history: InMemoryHistory

    constructor() {
        this.history = new InMemoryHistory()
    }

    listScopes(): string[] {
        return this.history.listScopes()
    }

    record(args: HistoryRecordArgs) {
        this.history.recordChange({
            storeName: args.storeName,
            changes: args.changes,
            ctx: args.opContext
        })
    }

    canUndo(scope: string): boolean {
        return this.history.canUndo(scope)
    }

    canRedo(scope: string): boolean {
        return this.history.canRedo(scope)
    }

    beginAction(args: { scope: string; label?: string; origin?: OperationContext['origin'] }): OperationContext {
        return createOperationContext({
            scope: String(args.scope || 'default'),
            origin: args.origin ?? 'user',
            label: args.label
        })
    }

    async undo(args: { scope: string; apply: HistoryApply }): Promise<boolean> {
        const action = this.history.popUndo(args.scope)
        if (!action) return false

        const opContext: OperationContext = createOperationContext({
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
                    opContext
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

        const opContext: OperationContext = createOperationContext({
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
                    opContext
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
        if (change.ctx.origin !== 'user') return
        if (!change.storeName) return

        const scope = change.ctx.scope || 'default'
        const actionId = change.ctx.actionId

        const stack = this.getStack(scope)
        const last = stack.undo[stack.undo.length - 1]

        if (last && last.actionId === actionId) {
            last.changes.push(change)
            if (!last.label && change.ctx.label) {
                last.label = change.ctx.label
            }
            stack.redo = []
            return
        }

        const next: ActionRecord = {
            scope,
            actionId,
            origin: 'user',
            label: change.ctx.label,
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
