import type { Patch } from 'immer'
import type { OperationContext } from '../types'

export type ChangeRecord = Readonly<{
    storeName: string
    patches: Patch[]
    inversePatches: Patch[]
    ctx: OperationContext
}>

export type ActionRecord = {
    scope: string
    actionId: string
    origin: 'user'
    label?: string
    changes: ChangeRecord[]
}

export type UndoStack = {
    undo: ActionRecord[]
    redo: ActionRecord[]
}

export class InMemoryHistory {
    private stacks = new Map<string, UndoStack>()

    getStack(scope: string): UndoStack {
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
        if (!actionId) return

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
}
