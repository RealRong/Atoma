import type { Patch } from 'immer'
import type { OperationContext } from 'atoma/core'

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
