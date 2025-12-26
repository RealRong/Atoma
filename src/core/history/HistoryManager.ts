import type { Patch } from 'immer'
import type { OperationContext } from '../types'
import { createActionId } from '../operationContext'
import { InMemoryHistory } from './InMemoryHistory'
import type { ActionRecord, UndoStack } from './types'
import { HistoryCommitter } from './HistoryCommitter'
import type { Committer } from '../mutation/types'

export type HistoryRecordArgs = Readonly<{
    storeName: string
    patches: Patch[]
    inversePatches: Patch[]
    opContext: OperationContext
}>

export type HistoryApplyArgs = Readonly<{
    storeName: string
    patches: Patch[]
    inversePatches: Patch[]
    opContext: OperationContext
}>

export type HistoryApply = (args: HistoryApplyArgs) => Promise<void>

export class HistoryManager {
    private readonly history: InMemoryHistory

    constructor(args?: { history?: InMemoryHistory }) {
        this.history = args?.history ?? new InMemoryHistory()
    }

    getStack(scope: string): UndoStack {
        return this.history.getStack(scope)
    }

    record(args: HistoryRecordArgs) {
        this.history.recordChange({
            storeName: args.storeName,
            patches: args.patches,
            inversePatches: args.inversePatches,
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
        return {
            scope: String(args.scope || 'default'),
            origin: args.origin ?? 'user',
            actionId: createActionId(),
            label: args.label,
            timestamp: Date.now()
        }
    }

    createCommitter(args: { inner: Committer; storeName: string; opContext: OperationContext }): Committer {
        return new HistoryCommitter({
            inner: args.inner,
            history: this,
            storeName: args.storeName,
            opContext: args.opContext
        })
    }

    async undo(args: { scope: string; apply: HistoryApply }): Promise<boolean> {
        const action = this.history.popUndo(args.scope)
        if (!action) return false

        const opContext: OperationContext = {
            scope: String(args.scope || 'default'),
            origin: 'history',
            actionId: createActionId(),
            label: action.label
        }

        try {
            for (let i = action.changes.length - 1; i >= 0; i--) {
                const change = action.changes[i]
                await args.apply({
                    storeName: change.storeName,
                    patches: change.inversePatches,
                    inversePatches: change.patches,
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

        const opContext: OperationContext = {
            scope: String(args.scope || 'default'),
            origin: 'history',
            actionId: createActionId(),
            label: action.label
        }

        try {
            for (let i = 0; i < action.changes.length; i++) {
                const change = action.changes[i]
                await args.apply({
                    storeName: change.storeName,
                    patches: change.patches,
                    inversePatches: change.inversePatches,
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

    popUndo(scope: string): ActionRecord | undefined {
        return this.history.popUndo(scope)
    }

    pushUndo(scope: string, action: ActionRecord) {
        this.history.pushUndo(scope, action)
    }

    popRedo(scope: string): ActionRecord | undefined {
        return this.history.popRedo(scope)
    }

    pushRedo(scope: string, action: ActionRecord) {
        this.history.pushRedo(scope, action)
    }
}
